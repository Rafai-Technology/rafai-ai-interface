import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line,
  LineChart, Pie, PieChart, ReferenceLine, ResponsiveContainer, Scatter,
  ScatterChart, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { ChartSpec, TraceStep } from '../types';
import { PALETTE, type Mode } from '../theme';
import { makeCategoryFormat } from '../format';
import { exportAsPdf, exportChartAsPng, exportRowsAsCsv, provenanceFrom } from '../export';
import { ExportFileCard } from './ExportFileCard';
import { IconDownload } from './icons';

interface Props {
  spec: ChartSpec;
  rows: Record<string, any>[];
  mode: Mode;
  /** Set only for a turn where the model called export_result — see
   *  ChatPanel.tsx. Renders a file card the user clicks to build and save the
   *  export; nothing downloads on its own. */
  exportRequest?: {
    format: 'csv' | 'pdf' | 'png';
    title: string;
    summary?: string;
    caveats?: string[];
  } | null;
  /** Trace and role travel with the export so a generated PDF can carry the
   *  SQL and the scope it was produced under, exactly as the on-screen
   *  inspector does. */
  trace?: TraceStep[];
  role?: string;
}

const AXIS_FONT = 12;

/** Beyond this, one shared y-axis makes the smaller series unreadable. */
const SCALE_RATIO_LIMIT = 8;

const PERCENTAGE_COLUMN = /(^|_)(pct|percent|percentage|rate|ratio|share)(_|$)/i;

/** Past six slices a pie stops being readable at a glance. */
const MAX_PIE_SEGMENTS = 6;

/** Column names whose values form a sequence, so a line between them is real. */
const TEMPORAL_KEY = /month|date|period|day|week|year|quarter|hour|time/i;
/** A value that is itself a date, whatever the column happens to be called. */
const LOOKS_TEMPORAL = (v: any) =>
  typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?/.test(v.trim());
/** Below this a categorical line is still legible, and some readers prefer it
 *  for a small ranked set. Above it there is no defence for the form. */
const LINE_CATEGORY_LIMIT = 12;

/**
 * Beyond this many bars the chart is PAGED, not squeezed and not scrolled.
 *
 * It used to force a min-width per bar and let the card scroll sideways. Two
 * things went wrong with that. The rotated category labels are drawn beyond
 * the plot's right edge, so the last one -- RAJKOT FCS, on an 18-branch
 * breakdown -- was clipped by the card rather than reachable by scrolling. And
 * a horizontal scrollbar inside a vertically scrolling answer is a poor
 * target: the wheel scrolls the page, and the bar itself is a few pixels tall.
 *
 * Paging keeps every bar at a legible width, keeps the labels inside the card,
 * and makes moving through the data an explicit control rather than a gesture
 * somebody has to discover.
 */
const BARS_PER_PAGE = 12;
/** On a phone twelve bars is about 24px each, which is a stripe, not a bar. */
const BARS_PER_PAGE_NARROW = 6;
/** Horizontal rows cost height, not width, and a card has more height to give
 *  before a row stops being readable. */
const HBARS_PER_PAGE = 14;
const HBARS_PER_PAGE_NARROW = 8;

/** Longest category label, in characters — the signal that bars should lie
 *  down. "VIJAYAWADA BHAVANIPURAM" and "RIVAN ALUMINIUM PRIVATE LIMITED" are
 *  ordinary values in this data, and vertical bars can only rotate or clip
 *  them. */
const LONG_LABEL_CHARS = 14;

/** Bars a Pareto draws before folding the remainder into one "Other". Beyond
 *  this the axis cannot letter the categories and the form stops showing the
 *  vital few, which is the only thing it is for. */
const PARETO_CATEGORIES = 8;
/** Characters of a category name a Pareto axis will letter before cutting.
 *  Rotated at -35 degrees, more than this runs past the edge of the card. */
const PARETO_LABEL_CHARS = 16;

// Marks are drawn at full size immediately: an entry animation adds nothing to
// an answer the reader is already waiting on, and it makes what is on screen at
// any instant depend on timing.
const NO_ANIMATION = { isAnimationActive: false } as const;

function isNumeric(v: any): boolean {
  return v !== null && v !== '' && Number.isFinite(Number(v));
}

/** Postgres returns numerics as strings; charting them as strings sorts wrong. */
function coerce(rows: Record<string, any>[], keys: string[]) {
  return rows.map((row) => {
    const out: Record<string, any> = { ...row };
    for (const k of keys) if (isNumeric(row[k])) out[k] = Number(row[k]);
    return out;
  });
}

function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(1)}Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n * 100) / 100);
}

function label(key: string): string {
  return key.replace(/_/g, ' ').replace(/\bpct\b/, '%');
}

/** Live width of an element, so tick density is decided from real pixels
 *  rather than a guess about the viewport. 0 until first measurement. */
function useMeasuredWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      // Rounded so a sub-pixel reflow does not re-render the chart forever.
      setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** Approximate advance width of the axis font, in px per character. Used only
 *  to decide how many labels fit; being a little pessimistic is the safe
 *  direction, since the cost is a rotated label rather than an overlap. */
const CHAR_PX = 6.9;
/** Horizontal room one rotated label needs before it touches its neighbour. */
const ROTATED_LABEL_PX = AXIS_FONT + 4;

/** Guards against the one theoretical race — a click landing before Recharts'
 *  ResizeObserver has sized the SVG — rather than asserting it away. */
function exportPngSafe(svg: SVGSVGElement | null, background: string, title: string): void {
  if (!svg) return;
  void exportChartAsPng(svg, background, title);
}

function maxOf(data: Record<string, any>[], key: string): number {
  return data.reduce((m, r) => (isNumeric(r[key]) ? Math.max(m, Math.abs(Number(r[key]))) : m), 0);
}

/**
 * True when the series are measured on scales too different to share an axis —
 * a count against a percentage, say. The fix is never a second y-axis: that
 * invents a correlation by choosing where the two scales line up. Small
 * multiples keep one scale per chart and let the reader compare shapes.
 */
function needsSmallMultiples(data: Record<string, any>[], series: string[]): boolean {
  if (series.length < 2) return false;

  // Unit mismatch is the stronger signal and the magnitude ratio can miss it:
  // an on-time percentage beside a consignment count only differs ~9x, but its
  // bars still collapse to stubs and its 76–88 spread — the actual finding —
  // becomes invisible.
  const percentages = series.filter((s) => PERCENTAGE_COLUMN.test(s)).length;
  if (percentages > 0 && percentages < series.length) return true;

  const maxes = series.map((s) => maxOf(data, s)).filter((m) => m > 0);
  if (maxes.length < 2) return false;
  return Math.max(...maxes) / Math.min(...maxes) > SCALE_RATIO_LIMIT;
}

export function ChartRenderer({ spec, rows, mode, exportRequest, trace, role }: Props) {
  const [showTable, setShowTable] = useState(false);
  const p = PALETTE[mode];
  const chartWrapRef = useRef<HTMLDivElement>(null);

  const data = useMemo(() => coerce(rows, spec.y), [rows, spec.y]);
  const series = spec.y.slice(0, 3);

  const title = exportRequest?.title || spec.title || label(spec.x);
  const exportColumns =
    spec.type === 'forecast' ? [spec.x, 'actual', 'forecast', 'lower', 'upper'] : [spec.x, ...series];

  // The rendered <svg> for whatever chart is currently on screen — grabbed
  // from the DOM rather than threaded through as a ref prop, so PNG/PDF
  // export needs no changes inside Plot() itself. Read at click time (never
  // eagerly), so the chart is always already mounted and sized by then.
  const currentSvg = () => chartWrapRef.current?.querySelector('svg') ?? null;

  const runRequestedExport = async () => {
    if (!exportRequest) return;
    if (exportRequest.format === 'csv') {
      exportRowsAsCsv(data, exportColumns, title);
    } else if (exportRequest.format === 'png') {
      const svg = currentSvg();
      if (!svg) throw new Error('no chart to export');
      await exportChartAsPng(svg, p.surface, title);
    } else {
      await exportAsPdf({
        title,
        summary: exportRequest.summary,
        caveats: exportRequest.caveats,
        provenance: provenanceFrom(trace ?? [], role),
        chartSvg: currentSvg(),
        chartBackground: p.surface,
        rows: data,
        columns: exportColumns,
      });
    }
  };

  const card = exportRequest && (
    <ExportFileCard
      format={exportRequest.format}
      title={title}
      /* Counted from what will actually be written, not from the request: the
         card should describe the file, and the file is built from these. */
      rowCount={rows.length}
      hasChart={Boolean(spec.x)}
      queryCount={(trace ?? []).filter((s) => s.tool === 'run_sql' && s.status === 'ok' && s.sql).length}
      caveatCount={exportRequest.caveats?.length ?? 0}
      onDownload={runRequestedExport}
    />
  );

  if (!series.length) return null;

  // A forecast is shaped by the server and always drawn the same way: the
  // projection and its interval are the answer, not decoration around it.
  if (spec.type === 'forecast') {
    const forecastSeries = ['actual', 'forecast', 'lower', 'upper'];
    return (
      <figure className="viz">
        <div className="viz-head">
          {spec.title && <figcaption className="viz-title">{spec.title}</figcaption>}
          <div className="viz-actions">
            <button
              className="ghost"
              onClick={() => setShowTable((v) => !v)}
              aria-pressed={showTable}
            >
              {showTable ? 'Show chart' : 'Show table'}
            </button>
            <DownloadMenu
              onPng={!showTable ? () => exportPngSafe(currentSvg(), p.surface, title) : undefined}
              onCsv={() => exportRowsAsCsv(data, [spec.x, ...forecastSeries], title)}
              onPdf={() =>
                exportAsPdf({
                  title,
                  provenance: provenanceFrom(trace ?? [], role),
                  chartSvg: showTable ? null : currentSvg(),
                  chartBackground: p.surface,
                  rows: data,
                  columns: [spec.x, ...forecastSeries],
                })
              }
            />
          </div>
        </div>
        <div key={showTable ? 'table' : 'chart'} className="chart-swap" ref={chartWrapRef}>
          {showTable ? (
            <DataTable data={data} x={spec.x} series={forecastSeries} />
          ) : (
            <Forecast data={data} x={spec.x} mode={mode} />
          )}
        </div>
        {card}
      </figure>
    );
  }

  // A one-bar chart or a two-slice pie is a stat tile wearing a costume.
  if (data.length < 3) {
    return (
      <figure className="viz">
        <div className="viz-head">
          {spec.title && <figcaption className="viz-title">{spec.title}</figcaption>}
          <DownloadMenu onCsv={() => exportRowsAsCsv(data, [spec.x, ...series], title)} />
        </div>
        {/* No chart is drawn for a 1-2 row result, so a PNG request has
            nothing to rasterize — CSV/PDF of the same two figures still
            makes sense and is offered either way. */}
        {exportRequest && exportRequest.format !== 'png' && (
          <ExportFileCard
            format={exportRequest.format}
            title={title}
            onDownload={() =>
              exportRequest.format === 'csv'
                ? exportRowsAsCsv(data, [spec.x, ...series], title)
                : exportAsPdf({ title, rows: data, columns: [spec.x, ...series] })
            }
          />
        )}
        <div className="stat-row">
          {(() => {
            const fmt = makeCategoryFormat(data.map((r) => r[spec.x]));
            return data.map((row, i) => (
              <div className="stat" key={i}>
                <div className="stat-value">
                  {isNumeric(row[series[0]]) ? compact(Number(row[series[0]])) : '—'}
                </div>
                <div className="stat-label">{fmt.short(row[spec.x])}</div>
              </div>
            ));
          })()}
        </div>
      </figure>
    );
  }

  /**
   * Long category labels lie the bars down.
   *
   * Vertical bars can only rotate a long label or clip it, and this data is
   * full of them — "VIJAYAWADA BHAVANIPURAM", "RIVAN ALUMINIUM PRIVATE
   * LIMITED", "CTS EXPRESS LOGISTICS PVT LTD". A rotated axis is read at an
   * angle and a clipped one is not read at all, so a ranking whose labels are
   * long is drawn horizontally whether the model asked for that or not. The
   * encoding is identical; only the axis the labels sit on changes.
   *
   * Never applied to a temporal axis: time reads left to right, and standing
   * a month series on its side is a worse chart, not a better one.
   */
  const labelsAreLong =
    !TEMPORAL_KEY.test(spec.x) &&
    data.some((r) => String(r[spec.x] ?? '').length > LONG_LABEL_CHARS);

  /* A scatter needs BOTH axes numeric. Asked for one over a branch name the
     x-axis would collapse every category to 0 and stack the whole dataset in a
     single column — so it falls back to the form that does work on a label. */
  const scatterUsable =
    spec.type === 'scatter' && data.every((r) => isNumeric(r[spec.x]));
  /* Stacking one series is just a bar with extra ceremony. */
  const stackUsable = spec.type === 'stacked' && series.length > 1;

  const requested: ChartSpec['type'] =
    (spec.type === 'scatter' && !scatterUsable) || (spec.type === 'stacked' && !stackUsable)
      ? 'bar'
      : spec.type;

  const coercedType: ChartSpec['type'] =
    requested === 'pie' && data.length > MAX_PIE_SEGMENTS
      ? (labelsAreLong ? 'hbar' : 'bar')
      : requested === 'bar' && labelsAreLong && series.length === 1
        ? 'hbar'
        : requested;
  const split = coercedType !== 'pie' && needsSmallMultiples(data, series);

  // What the reader could usefully switch to, given this exact result —
  // "more charts" is this, not more queries: the data already retrieved can
  // stand more than one representation, and re-plotting it costs nothing.
  const canPie = !split && series.length === 1 && data.length <= MAX_PIE_SEGMENTS;

  /**
   * Line is offered only when the x-axis is a SEQUENCE.
   *
   * A line says the space between two points is continuous and that the slope
   * between them means something. Between "BHOSARI CB" and "DELHI CB" it means
   * nothing -- the order is whatever the ORDER BY happened to be, and re-sorting
   * the query redraws the "trend". On a 70-branch breakdown the result was a
   * flat line with one spike at the end and a solid band of overlapping labels
   * underneath: unreadable, and describing a relationship that does not exist.
   *
   * Bar and pie both encode magnitude per category without implying anything
   * between categories, so they stay. Time keeps its line.
   */
  const temporalAxis = TEMPORAL_KEY.test(spec.x)
    || data.every((r) => LOOKS_TEMPORAL(r[spec.x]));
  const canLine = !split && (temporalAxis || data.length <= LINE_CATEGORY_LIMIT);

  /* A scatter plots two numeric columns against each other, so it has no
     categorical axis to re-plot as bars — it is offered alone. */
  const isScatter = coercedType === 'scatter';

  /**
   * Pareto needs a single ranked, non-negative series over categories. It is
   * meaningless on a time axis (a "cumulative share of months" answers no
   * question) and on values that can be negative, where a running total can
   * fall and the curve stops being cumulative in any readable sense.
   */
  const canPareto =
    !split && !temporalAxis && series.length === 1 && data.length >= 3 &&
    data.every((r) => Number(r[series[0]]) >= 0);

  /* Stacked is only honest when the series share a unit — parts of one whole.
     needsSmallMultiples already refuses the mismatched case, so reaching here
     with >1 series means they are comparable. */
  const canStack = !split && series.length > 1;

  const availableTypes: ChartSpec['type'][] = split || isScatter
    ? [coercedType]
    : ([
        'bar',
        'hbar',
        ...(canStack ? (['stacked'] as const) : []),
        ...(canLine ? (['line'] as const) : []),
        ...(canPareto ? (['pareto'] as const) : []),
        ...(canPie ? (['pie'] as const) : []),
      ] as ChartSpec['type'][]);

  return (
    <ChartWithTypeSwitch
      spec={spec}
      title={title}
      data={data}
      series={series}
      split={split}
      coercedType={coercedType}
      availableTypes={availableTypes}
      mode={mode}
      showTable={showTable}
      setShowTable={setShowTable}
      chartWrapRef={chartWrapRef}
      currentSvg={currentSvg}
      card={card}
      trace={trace}
      role={role}
    />
  );
}

/**
 * Split out so the chart-type switch has somewhere to keep its own state
 * without every earlier early return in ChartRenderer having to carry it.
 */
function ChartWithTypeSwitch({
  spec, title, data, series, split, coercedType, availableTypes, mode,
  showTable, setShowTable, chartWrapRef, currentSvg, card, trace, role,
}: {
  spec: ChartSpec;
  title: string;
  data: Record<string, any>[];
  series: string[];
  split: boolean;
  coercedType: ChartSpec['type'];
  availableTypes: ChartSpec['type'][];
  mode: Mode;
  showTable: boolean;
  setShowTable: (fn: (s: boolean) => boolean) => void;
  chartWrapRef: RefObject<HTMLDivElement>;
  currentSvg: () => SVGSVGElement | null;
  card: ReactNode;
  trace?: TraceStep[];
  role?: string;
}) {
  const p = PALETTE[mode];
  const [pickedType, setPickedType] = useState<ChartSpec['type'] | null>(null);
  const type = !split && pickedType && availableTypes.includes(pickedType) ? pickedType : coercedType;

  return (
    <figure className="viz">
      <div className="viz-head">
        {spec.title && <figcaption className="viz-title">{spec.title}</figcaption>}
        <div className="viz-actions">
          {!showTable && !split && availableTypes.length > 1 && (
            <div className="chart-type-switch" role="group" aria-label="Chart type">
              {availableTypes.map((t) => (
                <button
                  key={t}
                  className={type === t ? 'active' : ''}
                  onClick={() => setPickedType(t)}
                  aria-pressed={type === t}
                >
                  {t === 'bar' ? 'Bar'
                    : t === 'hbar' ? 'Rows'
                    : t === 'stacked' ? 'Stacked'
                    : t === 'line' ? 'Line'
                    : t === 'pareto' ? 'Pareto'
                    : t === 'scatter' ? 'Scatter'
                    : 'Pie'}
                </button>
              ))}
            </div>
          )}
          {/* Also the relief for the light-mode series that sit below 3:1
              against the light surface. */}
          <button
            className="ghost"
            onClick={() => setShowTable((s) => !s)}
            aria-pressed={showTable}
          >
            {showTable ? 'Show chart' : 'Show table'}
          </button>
          <DownloadMenu
            onPng={!showTable && !split ? () => exportPngSafe(currentSvg(), p.surface, title) : undefined}
            onCsv={() => exportRowsAsCsv(data, [spec.x, ...series], title)}
            onPdf={() =>
              exportAsPdf({
                title,
                provenance: provenanceFrom(trace ?? [], role),
                chartSvg: showTable || split ? null : currentSvg(),
                chartBackground: p.surface,
                rows: data,
                columns: [spec.x, ...series],
              })
            }
          />
        </div>
      </div>
      <div key={showTable ? 'table' : 'chart'} className="chart-swap" ref={chartWrapRef}>
      {showTable ? (
        <DataTable data={data} x={spec.x} series={series} />
      ) : split ? (
        <div className="small-multiples">
          {series.map((y, i) => (
            <div key={y}>
              <div className="viz-subtitle">{label(y)}</div>
              <Plot
                type={coercedType}
                data={data}
                x={spec.x}
                series={[y]}
                colors={[p.series[i]]}
                mode={mode}
                height={168}
              />
            </div>
          ))}
        </div>
      ) : (
        <Plot
          type={type}
          data={data}
          x={spec.x}
          series={series}
          colors={type === 'pie' ? p.slots : p.series}
          mode={mode}
          height={260}
        />
      )}
      </div>
      {/* Below the plot, not above it. Sitting between the header and the
          chart the card overlapped the plot area and read as part of the
          chart; a produced file is an outcome of the answer, so it belongs
          after the thing it was produced from. */}
      {card}
    </figure>
  );
}

/**
 * A single "Download" button that opens a tiny menu rather than three
 * separate buttons — three formats is one control's worth of choice, not
 * three. A format is omitted (not shown disabled) when there is nothing
 * sensible to export in it right now, e.g. PNG while the table is showing.
 */
function DownloadMenu({
  onPng, onCsv, onPdf,
}: {
  onPng?: () => void;
  onCsv?: () => void;
  onPdf?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  const run = (fn?: () => void) => {
    if (!fn) return;
    setOpen(false);
    void fn();
  };

  return (
    <div className="download-menu" ref={ref}>
      <button
        className="ghost"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <IconDownload /> Download
      </button>
      {open && (
        <div className="download-menu-list" role="menu">
          <button role="menuitem" disabled={!onPng} onClick={() => run(onPng)}>
            PNG image
          </button>
          <button role="menuitem" disabled={!onCsv} onClick={() => run(onCsv)}>
            CSV
          </button>
          <button role="menuitem" disabled={!onPdf} onClick={() => run(onPdf)}>
            PDF
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * History and projection on one axis, with the interval drawn as a band.
 *
 * The band matters more than the line: a forecast quoted as a single number
 * reads as a promise, and the honest content of a projection is its range. A
 * marker sits where actuals end so nobody mistakes the projection for measured
 * data.
 */
function Forecast({
  data, x, mode,
}: { data: Record<string, any>[]; x: string; mode: Mode }) {
  const p = PALETTE[mode];
  const handoff = [...data].reverse().find((r) => isNumeric(r.actual))?.[x];
  const fmt = makeCategoryFormat(data.map((r) => r[x]));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
        <CartesianGrid stroke={p.grid} strokeWidth={1} vertical={false} />
        <XAxis
          dataKey={x}
          stroke={p.axis}
          tick={{ fill: p.muted, fontSize: AXIS_FONT }}
          tickLine={false}
          tickFormatter={fmt.short}
          minTickGap={12}
        />
        <YAxis
          stroke={p.axis}
          tick={{ fill: p.muted, fontSize: AXIS_FONT }}
          tickLine={false}
          tickFormatter={compact}
          width={52}
        />
        <Tooltip
          contentStyle={{
            background: p.surface,
            border: `1px solid ${p.grid}`,
            borderRadius: 8,
            color: p.text,
            fontSize: 12,
          }}
          labelFormatter={(v: any) => fmt.full(v)}
          formatter={(v: any, name: string) => {
            // The band's dataKey yields a [lower, upper] pair, and history rows
            // yield [null, null]. Number([null,null]) is NaN, which is what was
            // showing in the tooltip.
            if (Array.isArray(v)) {
              const [lo, hi] = v;
              return [
                isNumeric(lo) && isNumeric(hi)
                  ? `${Number(lo).toLocaleString('en-IN')} – ${Number(hi).toLocaleString('en-IN')}`
                  : '—',
                label(name),
              ];
            }
            return [
              isNumeric(v) ? Number(v).toLocaleString('en-IN') : '—',
              label(name),
            ];
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: p.secondary }} />

        {/* Drawn first so the lines sit on top of it. */}
        <Area
          type="monotone"
          dataKey={(d: any) =>
            isNumeric(d.lower) && isNumeric(d.upper)
              ? [Number(d.lower), Number(d.upper)]
              : [null, null]
          }
          name="Confidence range"
          stroke="none"
          fill={p.series[1]}
          fillOpacity={0.16}
          isAnimationActive={false}
          legendType="rect"
        />

        {handoff !== undefined && (
          <ReferenceLine
            x={handoff}
            stroke={p.axis}
            strokeWidth={1}
            label={{ value: 'today', fill: p.muted, fontSize: 10, position: 'insideTopRight' }}
          />
        )}

        <Line
          type="monotone"
          dataKey="actual"
          name="Actual"
          stroke={p.series[0]}
          strokeWidth={2}
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
        {/* Dashed because it is projected, not measured. */}
        <Line
          type="monotone"
          dataKey="forecast"
          name="Forecast"
          stroke={p.series[1]}
          strokeWidth={2}
          strokeDasharray="5 4"
          dot={{ r: 3, fill: p.series[1], strokeWidth: 0 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function DataTable({
  data, x, series,
}: { data: Record<string, any>[]; x: string; series: string[] }) {
  // Same formatter the axis uses: the table is the accessible view of the
  // chart, and the two disagreeing about what a row is called is worse than
  // either format on its own.
  const fmt = makeCategoryFormat(data.map((r) => r[x]));
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>{label(x)}</th>
            {series.map((y) => <th key={y} className="num">{label(y)}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i}>
              <td>{fmt.short(row[x])}</td>
              {series.map((y) => (
                <td key={y} className="num">
                  {isNumeric(row[y]) ? Number(row[y]).toLocaleString('en-IN') : '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Plot({
  type, data, x, series, colors, mode, height,
}: {
  type: ChartSpec['type'];
  data: Record<string, any>[];
  x: string;
  series: string[];
  colors: readonly string[];
  mode: Mode;
  height: number;
}) {
  const p = PALETTE[mode];
  const wrapRef = useRef<HTMLDivElement>(null);
  const measured = useMeasuredWidth(wrapRef);

  const fmt = useMemo(() => makeCategoryFormat(data.map((r) => r[x])), [data, x]);
  /* Sizes the label gutter on horizontal bars. Measured off the SHORTENED
     label, because that is what is actually painted — sizing off the raw value
     reserves room for text the axis then ellipsises away. */
  const longestLabel = useMemo(
    () => data.reduce((m, r) => Math.max(m, String(fmt.short(r[x]) ?? '').length), 0),
    [data, x, fmt],
  );
  const num = (v: any) => (isNumeric(v) ? Number(v).toLocaleString('en-IN') : '—');

  // Narrow cards get a shorter plot and a tighter y-axis gutter: on a phone the
  // chart competes with the answer text for the fold, and 52px of axis is a
  // tenth of the screen.
  const narrow = measured > 0 && measured < 430;
  const plotHeight = narrow ? Math.min(height, 208) : height;
  const yAxisWidth = narrow ? 38 : 52;

  /* Paging is bar-only: a line chart reads fine with many points, and cutting
     a time series into pages would hide the shape that is the whole point.
     Horizontal bars page too, but hold more: a row costs ~26px of height
     whereas a vertical bar needs ~44px of width to stay a bar rather than a
     stripe, and vertical space is the axis a card can afford to spend. */
  const horizontal = type === 'hbar';
  const perPage = horizontal
    ? (narrow ? HBARS_PER_PAGE_NARROW : HBARS_PER_PAGE)
    : (narrow ? BARS_PER_PAGE_NARROW : BARS_PER_PAGE);
  const paged = (type === 'bar' || type === 'hbar' || type === 'stacked')
    && data.length > perPage;
  const [page, setPage] = useState(0);
  const pageCount = paged ? Math.ceil(data.length / perPage) : 1;
  /* Clamped rather than reset: when a filter shrinks the data under the
     current page the view must land on the last real page, not on an empty
     one. */
  const safePage = Math.min(page, pageCount - 1);
  const view = useMemo(
    () => (paged ? data.slice(safePage * perPage, (safePage + 1) * perPage) : data),
    [data, paged, safePage, perPage],
  );


  const tooltipStyle = {
    background: p.surface,
    border: `1px solid ${p.grid}`,
    borderRadius: 8,
    color: p.text,
    fontSize: 12,
    boxShadow: '0 6px 20px rgba(0,0,0,0.10)',
  };
  const axisProps = {
    stroke: p.axis,
    tick: { fill: p.muted, fontSize: AXIS_FONT },
    tickLine: false,
  };

  // Past this many bars, squeezing everything into the card's fixed width
  // makes every label overlap its neighbours no matter how they're rotated —
  // give each bar a real minimum width instead and let the card scroll.

  /**
   * How the category labels are laid out, decided from the measured card and
   * the labels that will actually be drawn — not from a row count.
   *
   * The old rule rotated at more than seven categories and always drew every
   * tick. With raw ISO timestamps that still overlapped at seven, and with
   * short labels it rotated when there was ample room. Ticks are only thinned
   * once rotation alone cannot separate them, because a dropped tick is lost
   * information and a rotated one is not.
   */
  const layout = useMemo(() => {
    const labels = view.map((r) => fmt.short(r[x]));
    const longest = labels.reduce((m, l) => Math.max(m, l.length), 0);
    const flatPx = longest * CHAR_PX + 12;
    // The window always fits the card, so the drawing surface is simply the
    // card minus its gutters — no forced min-width to reason about any more.
    const plotPx = Math.max(0, measured - yAxisWidth - 20);

    if (plotPx <= 0) {
      // Pre-measurement: assume rotation rather than flat, so the first paint
      // is never the overlapping one.
      return { angle: -35, interval: 0, height: Math.min(84, 24 + longest * 4.4) };
    }
    if (plotPx >= data.length * flatPx) {
      return { angle: 0, interval: 0, height: 30 };
    }
    const rotatedFit = Math.floor(plotPx / ROTATED_LABEL_PX);
    const interval = rotatedFit >= data.length
      ? 0
      : Math.max(0, Math.ceil(data.length / Math.max(1, rotatedFit)) - 1);
    return { angle: -35, interval, height: Math.min(84, 24 + longest * 4.4) };
  }, [view, x, fmt, measured, yAxisWidth]);

  const categoryAxis = {
    dataKey: x,
    ...axisProps,
    tickFormatter: fmt.short,
    interval: layout.interval,
    angle: layout.angle,
    textAnchor: layout.angle === 0 ? ('middle' as const) : ('end' as const),
    height: layout.height,
    minTickGap: 0,
  };

  const sharedTooltip = {
    contentStyle: tooltipStyle,
    // The axis is abbreviated to fit; the tooltip is where the unambiguous
    // value belongs, so it carries the full date and a grouped number.
    labelFormatter: (v: any) => fmt.full(v),
    formatter: (v: any, name: string) => [num(v), label(name)] as [string, string],
  };

  const legend = series.length > 1 && (
    <Legend wrapperStyle={{ fontSize: 12, color: p.secondary }} />
  );

  /**
   * Pareto: share per category as bars, cumulative share as a line.
   *
   * BOTH MARKS ARE PERCENTAGES, on one 0-100 axis. The textbook Pareto puts
   * counts on the left and cumulative percent on the right, and that is a
   * dual-axis chart — the two scales can be slid against each other to make
   * the crossover land wherever you like, so the "80% point" it appears to
   * show is an artefact of axis choice. Normalising the bars to share removes
   * the second axis entirely and the reading is unchanged: the bars still rank,
   * the curve still tells you how few categories carry most of the total.
   *
   * Absolute values are not lost — they stay in the tooltip and in the table.
   */
  const paretoData = useMemo(() => {
    if (type !== 'pareto') return null;
    const key = series[0];
    const sorted = [...data]
      .map((r) => ({ row: r, v: Math.max(0, Number(r[key]) || 0) }))
      /* A Pareto is sorted by definition. The model's ORDER BY is not to be
         trusted with that: an unsorted "cumulative" curve wanders up and down
         and stops meaning anything. */
      .sort((a, b) => b.v - a.v);
    const total = sorted.reduce((acc, e) => acc + e.v, 0);
    if (total <= 0) return null;

    /* The point of the form is the vital few, and a card cannot letter forty
       vendor names along an axis. The tail folds into one bar — it is not
       dropped, so the curve still reaches 100% and the total is still the real
       total. */
    const head = sorted.slice(0, PARETO_CATEGORIES);
    const tail = sorted.slice(PARETO_CATEGORIES);
    const tailValue = tail.reduce((acc, e) => acc + e.v, 0);

    const bars = head.map((e) => ({ ...e.row, __v: e.v }));
    if (tail.length) {
      bars.push({ [x]: `Other (${tail.length})`, [key]: tailValue, __v: tailValue });
    }

    let running = 0;
    return bars.map((r: any) => {
      running += r.__v;
      return { ...r, __share: (r.__v / total) * 100, __cum: (running / total) * 100 };
    });
  }, [type, data, series, x]);

  const plot = (
    <ResponsiveContainer width="100%" height={plotHeight}>
      {type === 'hbar' || type === 'stacked' ? (
        /* Horizontal and stacked share a chart element; only the layout and
           the stackId differ, so they cannot drift apart. */
        <BarChart
          data={view}
          layout={type === 'hbar' ? 'vertical' : 'horizontal'}
          margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
        >
          <CartesianGrid
            stroke={p.grid}
            strokeWidth={1}
            /* Grid lines run ACROSS the bars, never along them: a line down the
               length of a bar invites reading its end against a rule it is
               already touching. */
            vertical={type === 'hbar'}
            horizontal={type !== 'hbar'}
          />
          {type === 'hbar' ? (
            <>
              <XAxis type="number" {...axisProps} tickFormatter={compact} />
              <YAxis
                type="category"
                dataKey={x}
                {...axisProps}
                tickFormatter={fmt.short}
                /* The whole reason this form exists: a real gutter for the
                   label instead of a rotation or an ellipsis. Capped so one
                   very long name cannot squeeze the plot to nothing. */
                width={narrow ? 96 : Math.min(190, 8 + longestLabel * 7)}
                interval={0}
              />
            </>
          ) : (
            <>
              <XAxis {...categoryAxis} />
              <YAxis {...axisProps} tickFormatter={compact} width={yAxisWidth} />
            </>
          )}
          <Tooltip {...sharedTooltip} cursor={{ fill: p.grid, fillOpacity: 0.35 }} />
          {legend}
          {series.map((y, i) => (
            <Bar
              key={y}
              dataKey={y}
              name={label(y)}
              fill={colors[i]}
              /* Stacked segments carry a surface-coloured gap so two adjacent
                 fills never read as one block. */
              stroke={type === 'stacked' ? p.surface : undefined}
              strokeWidth={type === 'stacked' ? 2 : 0}
              stackId={type === 'stacked' ? 'a' : undefined}
              radius={
                type === 'hbar'
                  ? [0, 4, 4, 0]
                  : type === 'stacked'
                    ? (i === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0])
                    : [4, 4, 0, 0]
              }
              maxBarSize={type === 'hbar' ? 26 : 44}
              {...NO_ANIMATION}
            />
          ))}
        </BarChart>
      ) : type === 'scatter' ? (
        <ScatterChart margin={{ top: 8, right: 20, bottom: 8, left: 4 }}>
          <CartesianGrid stroke={p.grid} strokeWidth={1} />
          {/* Both axes are numeric here — this is the one form that plots a
              relationship rather than a ranking, so neither axis is a label. */}
          <XAxis
            type="number"
            dataKey={x}
            name={label(x)}
            {...axisProps}
            tickFormatter={compact}
          />
          <YAxis
            type="number"
            dataKey={series[0]}
            name={label(series[0])}
            {...axisProps}
            tickFormatter={compact}
            width={yAxisWidth}
          />
          <Tooltip
            {...sharedTooltip}
            cursor={{ stroke: p.axis, strokeWidth: 1, strokeDasharray: '3 3' }}
          />
          <Scatter
            data={data}
            fill={colors[0]}
            /* A surface ring keeps overlapping points countable in a dense
               cloud instead of merging into one shape. */
            stroke={p.surface}
            strokeWidth={1}
            {...NO_ANIMATION}
          />
        </ScatterChart>
      ) : type === 'pareto' && paretoData ? (
        <ComposedChart data={paretoData} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid stroke={p.grid} strokeWidth={1} vertical={false} />
          {/* A Pareto cannot page or lie down — the curve has to be read left to
              right in one go — so the axis absorbs the label length instead.
              Names are cut to a fixed budget and given the height that budget
              actually needs at -35 degrees; the full value stays in the tooltip
              and in the table. */}
          <XAxis
            {...categoryAxis}
            interval={0}
            tickFormatter={(v: any) => {
              const t = String(fmt.short(v) ?? '');
              return t.length > PARETO_LABEL_CHARS
                ? `${t.slice(0, PARETO_LABEL_CHARS - 1)}\u2026`
                : t;
            }}
            height={Math.min(96, 30 + PARETO_LABEL_CHARS * 3.6)}
          />
          {/* ONE axis, 0-100. See the note on paretoData. */}
          <YAxis
            {...axisProps}
            domain={[0, 100]}
            tickFormatter={(v: number) => `${v}%`}
            width={yAxisWidth}
          />
          <Tooltip
            {...sharedTooltip}
            cursor={{ fill: p.grid, fillOpacity: 0.35 }}
            formatter={(v: any, name: string) => [
              `${Number(v).toFixed(1)}%`,
              name,
            ] as [string, string]}
          />
          {/* Above the plot, not below it: the category labels here are long
              enough to be rotated, and a bottom legend sits directly on them. */}
          <Legend
            verticalAlign="top"
            align="right"
            wrapperStyle={{ fontSize: 12, color: p.secondary, paddingBottom: 6 }}
          />
          {/* 80% is the line people are looking for; drawn once, labelled, and
              recessive so it never competes with the data. */}
          <ReferenceLine
            y={80}
            stroke={p.axis}
            strokeDasharray="4 4"
            /* insideTopRight, not right: outside the plot it is clipped by the
               chart margin and renders as "8C". */
            label={{
              value: '80%', position: 'insideTopRight',
              fill: p.muted, fontSize: 11,
            }}
          />
          <Bar
            dataKey="__share"
            name={`${label(series[0])} share`}
            fill={colors[0]}
            radius={[4, 4, 0, 0]}
            maxBarSize={44}
            {...NO_ANIMATION}
          />
          <Line
            type="monotone"
            dataKey="__cum"
            name="Cumulative"
            stroke={colors[1] ?? p.secondary}
            strokeWidth={2}
            dot={false}
            {...NO_ANIMATION}
          />
        </ComposedChart>
      ) : type === 'line' ? (
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid stroke={p.grid} strokeWidth={1} vertical={false} />
          <XAxis {...categoryAxis} />
          <YAxis {...axisProps} tickFormatter={compact} width={yAxisWidth} />
          <Tooltip {...sharedTooltip} cursor={{ stroke: p.axis, strokeWidth: 1 }} />
          {legend}
          {series.map((y, i) => (
            <Line
              key={y}
              type="monotone"
              dataKey={y}
              name={label(y)}
              stroke={colors[i]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: p.surface }}
              {...NO_ANIMATION}
            />
          ))}
        </LineChart>
      ) : type === 'pie' ? (
        <PieChart>
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(v: any, name: string) => [num(v), fmt.short(name)] as [string, string]}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: p.secondary }} formatter={fmt.short} />
          <Pie
            data={data}
            dataKey={series[0]}
            nameKey={x}
            innerRadius={narrow ? 40 : 52}
            outerRadius={narrow ? 70 : 92}
            paddingAngle={2}
            stroke={p.surface}
            strokeWidth={2}
            {...NO_ANIMATION}
          >
            {/* Segments are capped at six, so a slot is never reused — two
                buckets sharing a hue would read as one category. */}
            {data.map((_, i) => <Cell key={i} fill={colors[i]} />)}
          </Pie>
        </PieChart>
      ) : (
        <BarChart data={view} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid stroke={p.grid} strokeWidth={1} vertical={false} />
          <XAxis {...categoryAxis} />
          <YAxis {...axisProps} tickFormatter={compact} width={yAxisWidth} />
          <Tooltip {...sharedTooltip} cursor={{ fill: p.grid, fillOpacity: 0.35 }} />
          {legend}
          {series.map((y, i) => (
            <Bar
              key={y}
              dataKey={y}
              name={label(y)}
              // One series is one colour for every bar. Shading bars by their
              // own value would double-encode length as hue.
              fill={colors[i]}
              radius={[4, 4, 0, 0]}
              maxBarSize={44}
              {...NO_ANIMATION}
            />
          ))}
        </BarChart>
      )}
    </ResponsiveContainer>
  );

  if (!paged) return <div ref={wrapRef}>{plot}</div>;

  const from = safePage * perPage + 1;
  const to = Math.min((safePage + 1) * perPage, data.length);

  return (
    <div ref={wrapRef}>
      {plot}
      {/* The control says which slice of the data is on screen, not just which
          page number — "13–18 of 18" is checkable against the table; "2 / 2"
          is not. */}
      <div className="chart-pager">
        <button
          type="button"
          onClick={() => setPage(safePage - 1)}
          disabled={safePage === 0}
          aria-label="Previous bars"
        >
          ‹
        </button>
        <span className="chart-pager-range">
          {from}–{to} <span className="chart-pager-of">of {data.length}</span>
        </span>
        <button
          type="button"
          onClick={() => setPage(safePage + 1)}
          disabled={safePage >= pageCount - 1}
          aria-label="Next bars"
        >
          ›
        </button>
      </div>
    </div>
  );
}

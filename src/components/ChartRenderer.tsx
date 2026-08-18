import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line,
  LineChart, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip,
  XAxis, YAxis,
} from 'recharts';
import type { ChartSpec, TraceStep } from '../types';
import { PALETTE, type Mode } from '../theme';
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

/** Beyond this many bars, rotated labels start overlapping regardless of how
 *  wide the card is — the fix is more actual pixels, not a tighter squeeze. */
const SCROLL_BAR_COUNT = 15;
/** Wide enough that a -30° label clears its neighbour at this bar's width. */
const MIN_BAR_PX = 46;

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
    <ExportFileCard format={exportRequest.format} title={title} onDownload={runRequestedExport} />
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
        {card}
        <div key={showTable ? 'table' : 'chart'} className="chart-swap" ref={chartWrapRef}>
          {showTable ? (
            <DataTable data={data} x={spec.x} series={forecastSeries} />
          ) : (
            <Forecast data={data} x={spec.x} mode={mode} />
          )}
        </div>
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
          {data.map((row, i) => (
            <div className="stat" key={i}>
              <div className="stat-value">
                {isNumeric(row[series[0]]) ? compact(Number(row[series[0]])) : '—'}
              </div>
              <div className="stat-label">{String(row[spec.x])}</div>
            </div>
          ))}
        </div>
      </figure>
    );
  }

  const coercedType = spec.type === 'pie' && data.length > MAX_PIE_SEGMENTS ? 'bar' : spec.type;
  const split = coercedType !== 'pie' && needsSmallMultiples(data, series);

  // What the reader could usefully switch to, given this exact result —
  // "more charts" is this, not more queries: the data already retrieved can
  // stand more than one representation, and re-plotting it costs nothing.
  const canPie = !split && series.length === 1 && data.length <= MAX_PIE_SEGMENTS;
  const availableTypes: ChartSpec['type'][] = split
    ? [coercedType]
    : (['bar', 'line', ...(canPie ? (['pie'] as const) : [])] as ChartSpec['type'][]);

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
                  {t === 'bar' ? 'Bar' : t === 'line' ? 'Line' : 'Pie'}
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
      {card}

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

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
        <CartesianGrid stroke={p.grid} strokeWidth={1} vertical={false} />
        <XAxis
          dataKey={x}
          stroke={p.axis}
          tick={{ fill: p.muted, fontSize: AXIS_FONT }}
          tickLine={false}
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
              <td>{String(row[x])}</td>
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
  const crowded = data.length > 7;
  // Past this many bars, squeezing everything into the card's fixed width
  // makes every label overlap its neighbours no matter how they're rotated —
  // give each bar a real minimum width instead and let the card scroll.
  const manyBars = type === 'bar' && data.length > SCROLL_BAR_COUNT;
  const legend = series.length > 1 && (
    <Legend wrapperStyle={{ fontSize: 12, color: p.secondary }} />
  );

  const plot = (
    <ResponsiveContainer width="100%" height={height}>
      {type === 'line' ? (
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid stroke={p.grid} strokeWidth={1} vertical={false} />
          <XAxis dataKey={x} {...axisProps} />
          <YAxis {...axisProps} tickFormatter={compact} width={52} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ stroke: p.axis, strokeWidth: 1 }} />
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
          <Tooltip contentStyle={tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 12, color: p.secondary }} />
          <Pie
            data={data}
            dataKey={series[0]}
            nameKey={x}
            innerRadius={52}
            outerRadius={92}
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
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid stroke={p.grid} strokeWidth={1} vertical={false} />
          <XAxis
            dataKey={x}
            {...axisProps}
            interval={0}
            angle={crowded ? -30 : 0}
            textAnchor={crowded ? 'end' : 'middle'}
            height={crowded ? 62 : 30}
          />
          <YAxis {...axisProps} tickFormatter={compact} width={52} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ fill: p.grid, fillOpacity: 0.35 }} />
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

  if (!manyBars) return plot;

  // The inner div's min-width is a floor, not a fixed size: it fills the
  // card as normal up to that many bars' worth of room, and only forces the
  // outer div into horizontal scroll once there are more bars than the card
  // can show at a legible width.
  return (
    <div className="chart-scroll">
      <div style={{ minWidth: data.length * MIN_BAR_PX, height }}>
        {plot}
      </div>
    </div>
  );
}

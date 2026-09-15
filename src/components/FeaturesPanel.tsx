import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Mode } from '../theme';
import type { DashboardPanelResult, DashboardRun, DashboardSummary } from '../types';
import { deleteDashboard, listDashboards, runDashboard, setDashboardPinned, reorderDashboardPanels } from '../api';
import { ChartRenderer } from './ChartRenderer';
import { IconPin } from './icons';

/* ------------------------------------------------------------- formatting */

/** Columns whose values are rupees. Used only to choose a FORMAT, never to
 *  decide what a number means. */
const MONEY = /(^|_)(amount|revenue|freight|cost|value|outstanding|balance|charge|total|paid|received)(_|$)/i;
const COUNTISH = /(^|_)(count|consignments|lrs|rows|trips|vehicles|invoices|panels|days|hours|qty|pieces)(_|$)/i;

/**
 * Indian money shorthand, because that is how the figures are spoken about.
 * ₹5.56 Cr is read instantly; ₹5,55,64,880 has to be counted.
 *
 * Applied on NAME, so a column that merely holds a big number is left alone —
 * "1.2 Cr consignments" would be nonsense.
 */
function formatCell(column: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number') {
    const s = String(value);
    return /^\d{4}-\d{2}-\d{2}T/.test(s)
      ? new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
      : s;
  }
  if (MONEY.test(column) && !COUNTISH.test(column)) {
    const abs = Math.abs(value);
    if (abs >= 1e7) return `₹${(value / 1e7).toFixed(2)} Cr`;
    if (abs >= 1e5) return `₹${(value / 1e5).toFixed(2)} L`;
    return `₹${value.toLocaleString('en-IN')}`;
  }
  return Number.isInteger(value)
    ? value.toLocaleString('en-IN')
    : value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** "just now" / "4 min ago" — a dashboard's honesty depends on this being read. */
function ago(iso: string, now: number): string {
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Ticks once a second so "live as of" cannot quietly become a lie. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/* ------------------------------------------------------------------ shape */

type Shape = 'figure' | 'chart' | 'table' | 'off';

/**
 * What a panel IS decides how much room it gets.
 *
 * A one-row result is a headline and belongs in a small tile; a chart needs
 * width to be readable; a ten-column table needs the whole row. Giving all
 * three an identical box — the obvious grid — buries the headline numbers and
 * squeezes the tables, which is the usual reason dashboards are hard to scan.
 */
function shapeOf(p: DashboardPanelResult): Shape {
  if (p.status !== 'ok') return 'off';
  const cols = p.rows.length ? Object.keys(p.rows[0]).length : 0;
  if (p.chartSpec && p.rows.length > 1) return 'chart';
  if (p.rows.length === 1 && cols <= 4) return 'figure';
  return 'table';
}

const SPAN: Record<Shape, number> = { figure: 3, chart: 6, table: 6, off: 3 };

/* The grid's row unit and the gap between panels, in pixels. Must match the
   values in styles.css — a panel's row span is derived from them. */
const ROW_UNIT = 8;
const ROW_GAP = 14;

/**
 * Masonry, the only way CSS Grid can currently do it.
 *
 * Grid sizes a row by its tallest item, so a 430px table beside a 220px stat
 * tile leaves 210px of nothing under the tile. A fixed row span per shape does
 * not fix it either: guess low and the tile clips, guess high and the gap comes
 * back. So the panel is MEASURED after it renders and claims exactly the rows
 * it needs, over a row unit fine enough (8px) that the rounding is invisible.
 *
 * `dense` flow then packs two short tiles into the height of one chart, which
 * is what closes the gaps.
 */
function useRowSpan<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [rows, setRows] = useState(24);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) setRows(Math.ceil((h + ROW_GAP) / (ROW_UNIT + 0)));
    };
    measure();
    /* Charts settle asynchronously and a table's scrollbar changes its height,
       so one measurement at mount is not enough. */
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, rows };
}

/**
 * How many x values a chart repeats.
 *
 * A time series with "Apr 2026" on twelve different bars is not a time series:
 * it is un-aggregated detail — one row per branch per month — drawn as though
 * each row were its own period. The chart looks plausible and every bar is
 * wrong, which is the worst way for a dashboard to fail.
 *
 * Cheap to detect and impossible to unsee once flagged, so the panel says so
 * rather than leaving somebody to notice the repeated labels themselves.
 */
function repeatedCategories(p: DashboardPanelResult): number {
  const x = p.chartSpec?.x;
  if (!x || p.rows.length < 2) return 0;
  const seen = new Set(p.rows.map((r) => String(r[x] ?? '')));
  return p.rows.length - seen.size;
}

/**
 * Longest category label a chart has to fit along its x axis, as RENDERED.
 *
 * A date arrives as `2026-04-01T00:00:00.000Z` — 24 characters — and draws as
 * "Apr 2026". Measuring the raw value made every time series look like it had
 * enormous labels and pushed each one to full width.
 */
function widestLabel(p: DashboardPanelResult): number {
  const x = p.chartSpec?.x;
  if (!x) return 0;
  return p.rows.reduce((w, r) => {
    const raw = String(r[x] ?? '');
    const rendered = /^\d{4}-\d{2}-\d{2}/.test(raw) ? 8 : raw.length;
    return Math.max(w, rendered);
  }, 0);
}

function spanFor(p: DashboardPanelResult, shape: Shape): number {
  if (shape === 'chart') {
    /* Customer and branch names run long — "CTS EXPRESS LOGISTIC PVT LTD" is
       28 characters. In a half-width panel those labels rotate and clip, so a
       chart carrying long categories takes the whole row instead. Measured off
       the actual values rather than guessed from the column name. */
    return widestLabel(p) > 14 ? 12 : 6;
  }
  if (shape !== 'table') return SPAN[shape];
  const cols = p.rows.length ? Object.keys(p.rows[0]).length : 0;
  return cols > 4 ? 12 : 6;
}

/**
 * Give every row a full twelve columns.
 *
 * Spans are chosen per panel from its content, which is right for each one and
 * leaves the last row of the grid short — a lone half-width chart sitting
 * beside an empty half. Walking the spans and growing the final panel to
 * consume what is left costs nothing and removes the gap that reads as a
 * layout bug.
 */
function fillRows(spans: number[]): number[] {
  const out = [...spans];
  let row = 0;
  let startOfRow = 0;
  for (let i = 0; i < out.length; i++) {
    if (row + out[i] > 12) { row = out[i]; startOfRow = i; }
    else row += out[i];
  }
  const leftover = 12 - row;
  if (leftover > 0 && out.length > startOfRow) out[out.length - 1] += leftover;
  return out;
}

/**
 * Headline numbers first.
 *
 * A one-row figure is the thing somebody opens the dashboard to read, and left
 * in author order it lands wherever the conversation happened to produce it —
 * in practice, stranded on a row of its own under two full-width charts. This
 * is the one place the saved order is overridden, and only to lift figures to
 * the top; everything else keeps its position.
 */
/**
 * The saved order, unchanged.
 *
 * This used to float stat figures to the front, which was a reasonable default
 * when nobody could say otherwise. Panels can now be dragged into an order and
 * that order is stored, so re-sorting here would quietly undo the arrangement
 * somebody just made — the card would spring back and the drag would look
 * broken. An automatic heuristic yields to an explicit choice.
 *
 * Boards saved before this keep their creation order, which is what the
 * database always held; the difference is that it is now visible and can be
 * changed.
 */
function forDisplay(panels: DashboardPanelResult[]): DashboardPanelResult[] {
  return panels;
}

/* --------------------------------------------------------------- fragments */

function Figures({ rows }: { rows: Record<string, any>[] }) {
  const row = rows[0] ?? {};
  const cols = Object.keys(row);
  return (
    <div className="fig-set">
      {cols.map((c) => (
        <div className="fig" key={c}>
          <span className="fig-label">{c.replace(/_/g, ' ')}</span>
          <span className="fig-value">{formatCell(c, row[c])}</span>
        </div>
      ))}
    </div>
  );
}

function DataTable({ rows, limit = 60, onExpand, truncated = false, total }: {
  rows: Record<string, any>[];
  limit?: number;
  /** Present on a tile: the rest of the rows live in the expanded view rather
   *  than in a panel tall enough to distort the whole grid. */
  onExpand?: () => void;
  /** The query matched more rows than were returned. Saying "all 1,000" when
   *  the result was capped out of 2,376 would be a quiet lie. */
  truncated?: boolean;
  total?: number;
}) {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const more = rows.length > limit;
  return (
    <>
    <div className="dt-wrap">
      <table className="dt">
        <thead>
          <tr>{cols.map((c) => (
            <th key={c} className={typeof rows[0][c] === 'number' ? 'num' : undefined}>
              {c.replace(/_/g, ' ')}
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className={typeof r[c] === 'number' ? 'num' : undefined}>
                  {formatCell(c, r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {/* Outside the scroll window on purpose: inside it, the way out of a
        truncated table scrolls out of sight. */}
    {more && (
      onExpand ? (
        <button type="button" className="dt-all" onClick={onExpand}>
          {truncated && total
            ? `Show the ${rows.length.toLocaleString('en-IN')} rows retrieved (of ${total.toLocaleString('en-IN')} matched)`
            : `Show all ${rows.length.toLocaleString('en-IN')} rows`}
        </button>
      ) : (
        <p className="dt-more">
          Showing {limit.toLocaleString('en-IN')} of {rows.length.toLocaleString('en-IN')} rows
          {truncated && total ? ` retrieved — the query matched ${total.toLocaleString('en-IN')}` : ''}
        </p>
      )
    )}
    </>
  );
}

/**
 * The expanded table: searchable and sortable.
 *
 * A thousand rows of compliance data is only useful if you can find the vehicle
 * you came for. Filtering happens in the browser over rows already fetched — it
 * does NOT re-query, so it can never widen what the row cap or the branch scope
 * already decided. What you can search is exactly what you were allowed to see.
 */
function FilterableTable({ rows, truncated, total }: {
  rows: Record<string, any>[];
  truncated?: boolean;
  total?: number;
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  const cols = rows.length ? Object.keys(rows[0]) : [];

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = needle
      ? rows.filter((r) => cols.some((c) => {
          const v = r[c];
          if (v === null || v === undefined) return false;
          /* Search the FORMATTED value as well as the raw one, so typing
             "5.56 Cr" finds what the screen actually shows. */
          return String(v).toLowerCase().includes(needle)
            || formatCell(c, v).toLowerCase().includes(needle);
        }))
      : rows;
    if (sort) {
      out = [...out].sort((a, b) => {
        const x = a[sort.col], y = b[sort.col];
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * sort.dir;
        return String(x).localeCompare(String(y)) * sort.dir;
      });
    }
    return out;
  }, [rows, q, sort, cols]);

  const toggle = (c: string) =>
    setSort((s) => (s && s.col === c ? { col: c, dir: s.dir === 1 ? -1 : 1 } : { col: c, dir: 1 }));

  return (
    <>
      <div className="ft-bar">
        <input
          className="ft-search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${rows.length.toLocaleString('en-IN')} rows…`}
          aria-label="Filter rows"
        />
        <span className="ft-count">
          {q.trim()
            ? `${view.length.toLocaleString('en-IN')} of ${rows.length.toLocaleString('en-IN')}`
            : truncated && total
              ? `${rows.length.toLocaleString('en-IN')} retrieved of ${total.toLocaleString('en-IN')} matched`
              : `${rows.length.toLocaleString('en-IN')} rows`}
        </span>
      </div>

      <div className="dt-wrap ft-scroll">
        <table className="dt">
          <thead>
            <tr>
              {cols.map((c) => (
                <th
                  key={c}
                  className={typeof rows[0][c] === 'number' ? 'num sortable' : 'sortable'}
                  onClick={() => toggle(c)}
                  aria-sort={sort?.col === c ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                >
                  {c.replace(/_/g, ' ')}
                  <span className="ft-caret" aria-hidden="true">
                    {sort?.col === c ? (sort.dir === 1 ? '▲' : '▼') : ''}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.slice(0, 500).map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c} className={typeof r[c] === 'number' ? 'num' : undefined}>
                    {formatCell(c, r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {view.length === 0 && <p className="ft-none">Nothing matches “{q}”.</p>}
        {view.length > 500 && (
          <p className="dt-more">Showing the first 500 of {view.length.toLocaleString('en-IN')} matching rows</p>
        )}
      </div>
    </>
  );
}

/**
 * The loading placeholder.
 *
 * Uniform on purpose. Until the panels come back nothing knows which will be a
 * stat tile and which a chart, and guessing produces a ragged grid that then
 * rearranges itself — worse than a plain one. The count IS known (the list card
 * says how many panels a dashboard has), so the placeholder gets that right and
 * makes no claim about the rest.
 */
const SKELETON_HEIGHT = 264;

function Skeleton() {
  return (
    <section
      className="pnl is-loading"
      style={{
        ['--span' as any]: 6,
        ['--rows' as any]: Math.ceil((SKELETON_HEIGHT + ROW_GAP) / ROW_UNIT),
      }}
      aria-hidden="true"
    >
      <div className="pnl-inner">
        <header className="pnl-head">
          <div className="sk sk-title" />
          <div className="sk sk-tag" />
        </header>
        <div className="sk sk-body" />
        <div className="sk sk-foot" />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ expand */

/**
 * One panel, given the whole screen.
 *
 * A dashboard tile is a summary — deliberately small, so several fit. But a
 * 164-row chart or a wide table cannot be read at tile size, and the honest
 * answer is not to shrink the type further: it is to let the panel open. The
 * query, the caveats and the full result all come along, so the expanded view
 * is the place to actually interrogate a figure rather than just notice it.
 */
function PanelModal({ p, mode, role, onClose }: {
  p: DashboardPanelResult; mode: Mode; role: string; onClose: () => void;
}) {
  /* Escape closes, and the page behind must not scroll while it is open. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const shape = shapeOf(p);

  return (
    <div
      className="pm-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={p.title}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="pm">
        <header className="pm-head">
          <div>
            <h3>{p.title}</h3>
            <p className="pm-meta">
              {p.status === 'ok'
                ? `${p.truncated
                      ? `${p.rows.length.toLocaleString('en-IN')} of ${p.rowCount.toLocaleString('en-IN')} rows (capped)`
                      : `${p.rowCount.toLocaleString('en-IN')} row${p.rowCount === 1 ? '' : 's'}`} · ${p.durationMs} ms · fetched just now under your own access`
                : 'Not run'}
            </p>
          </div>
          <button type="button" className="pm-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="pm-body">
          {p.status !== 'ok' ? (
            <div className="pnl-state">
              <span className={`state-badge ${p.status === 'blocked' ? 'state-locked' : 'state-error'}`}>
                {p.status === 'blocked' ? 'Not shown' : 'Failed'}
              </span>
              <p>{p.reason}</p>
            </div>
          ) : shape === 'chart' ? (
            <>
              {repeatedCategories(p) > 0 && (
                <div className="pm-warn">
                  <strong>This chart repeats {repeatedCategories(p)} of its {p.rowCount} categories.</strong>
                  {' '}The query returns more than one row per point on the x axis — usually
                  detail that was never aggregated, drawn as though each row were its own
                  period. Check the query below: it most likely needs a <code>GROUP BY</code>
                  {' '}on <code>{p.chartSpec?.x}</code> with the measure summed.
                </div>
              )}
              <ChartRenderer spec={p.chartSpec!} rows={p.rows} mode={mode} role={role} />
              {/* The numbers behind the picture, without a second click. */}
              <details className="pm-rows">
                <summary>All {p.rowCount.toLocaleString('en-IN')} rows</summary>
                <FilterableTable rows={p.rows} truncated={p.truncated} total={p.rowCount} />
              </details>
            </>
          ) : shape === 'figure' ? (
            <Figures rows={p.rows} />
          ) : (
            <FilterableTable rows={p.rows} truncated={p.truncated} total={p.rowCount} />
          )}

          {p.caveats.length > 0 && (
            <ul className="pnl-caveats">
              {p.caveats.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          )}

          <div className="pm-sql">
            <span className="pm-sql-label">The query this panel just ran</span>
            <pre>{p.sql}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- panel */

function Panel({ p, mode, role, span, drag }: {
  p: DashboardPanelResult; mode: Mode; role: string; span: number;
  /** Omitted while the board is busy, which disables reordering wholesale. */
  drag?: {
    index: number;
    count: number;
    isDragging: boolean;
    isOver: boolean;
    onStart: (i: number) => void;
    onOver: (i: number) => void;
    onDrop: (i: number) => void;
    onEnd: () => void;
    onMove: (from: number, to: number) => void;
  };
}) {
  const shape = shapeOf(p);
  const [expanded, setExpanded] = useState(false);
  const { ref, rows } = useRowSpan<HTMLDivElement>();

  return (
    <section
      className={`pnl pnl-${shape}${drag?.isDragging ? ' dragging' : ''}${
        drag?.isOver ? ' drop-target' : ''
      }`}
      style={{ ['--span' as any]: span, ['--rows' as any]: rows }}
      aria-label={p.title}
      /* The whole card is the drop zone but only the handle starts a drag:
         making the card itself draggable turned every attempt to select a
         number in it into a drag. */
      onDragOver={drag ? (e) => { e.preventDefault(); drag.onOver(drag.index); } : undefined}
      onDrop={drag ? (e) => { e.preventDefault(); drag.onDrop(drag.index); } : undefined}
    >
     <div className="pnl-inner" ref={ref}>
      <header className="pnl-head">
        {drag && (
          /* A handle, and two buttons that do the same job from a keyboard.
             Drag alone would put reordering out of reach for anyone not using
             a mouse, and this is the only way to arrange a board. */
          <span className="pnl-grip-set">
            <span
              className="pnl-grip"
              draggable
              role="button"
              tabIndex={-1}
              aria-hidden="true"
              title="Drag to reorder — the order is saved for everyone"
              onDragStart={(e) => {
                // Firefox will not start a drag without payload on the event.
                e.dataTransfer.setData('text/plain', String(drag.index));
                e.dataTransfer.effectAllowed = 'move';
                drag.onStart(drag.index);
              }}
              onDragEnd={drag.onEnd}
            >
              ⠿
            </span>
            <span className="pnl-move">
              <button
                type="button"
                disabled={drag.index === 0}
                aria-label={`Move ${p.title} earlier`}
                onClick={() => drag.onMove(drag.index, drag.index - 1)}
              >
                ‹
              </button>
              <button
                type="button"
                disabled={drag.index === drag.count - 1}
                aria-label={`Move ${p.title} later`}
                onClick={() => drag.onMove(drag.index, drag.index + 1)}
              >
                ›
              </button>
            </span>
          </span>
        )}
        <h3>{p.title}</h3>
        <div className="pnl-tags">
          {p.status === 'ok' && p.rowCount > 1 && (
            <span className="tag">
              {p.truncated
                ? `${p.rows.length.toLocaleString('en-IN')} of ${p.rowCount.toLocaleString('en-IN')}`
                : `${p.rowCount.toLocaleString('en-IN')} rows`}
            </span>
          )}
          {p.truncated && <span className="tag tag-warn">capped</span>}
          {shape === 'chart' && repeatedCategories(p) > 0 && (
            <span className="tag tag-warn" title="The x axis repeats values — this result is probably not aggregated">
              repeats
            </span>
          )}
          {p.status === 'ok' && <span className="tag tag-quiet">{p.durationMs} ms</span>}
          <button
            type="button"
            className="pnl-open"
            onClick={() => setExpanded(true)}
            aria-label={`Open ${p.title}`}
            title="Open"
          >
            <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
              <path d="M5.5 1.5H1.5V5.5M8.5 12.5H12.5V8.5M12.5 5.5V1.5H8.5M1.5 8.5V12.5H5.5"
                fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

      {p.status === 'blocked' ? (
        <div className="pnl-state">
          <span className="state-badge state-locked">Not shown</span>
          <p>{p.reason}</p>
        </div>
      ) : p.status === 'error' ? (
        <div className="pnl-state">
          <span className="state-badge state-error">Failed</span>
          <p>{p.reason}</p>
        </div>
      ) : shape === 'chart' ? (
        <ChartRenderer spec={p.chartSpec!} rows={p.rows} mode={mode} role={role} />
      ) : shape === 'figure' ? (
        <Figures rows={p.rows} />
      ) : p.rows.length === 0 ? (
        <div className="pnl-state">
          <span className="state-badge state-empty">No rows</span>
          <p>The query ran and returned nothing for your access.</p>
        </div>
      ) : (
        <DataTable
          rows={p.rows}
          limit={8}
          onExpand={() => setExpanded(true)}
          truncated={p.truncated}
          total={p.rowCount}
        />
      )}

      {p.caveats.length > 0 && (
        <ul className="pnl-caveats">
          {p.caveats.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      )}

      <details className="pnl-sql">
        <summary>Show the query</summary>
        <pre>{p.sql}</pre>
      </details>
     </div>

      {expanded && (
        <PanelModal p={p} mode={mode} role={role} onClose={() => setExpanded(false)} />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------- shell */

/**
 * `openId` comes from the URL, and opening or closing a dashboard navigates
 * rather than setting local state — so a dashboard has its own address and a
 * refresh reopens it.
 */
export function FeaturesPanel({ mode, role, openId, onOpen, onBack }: {
  mode: Mode;
  role: string;
  openId: string | null;
  onOpen: (id: string) => void;
  onBack: () => void;
}) {
  const [list, setList] = useState<DashboardSummary[]>([]);
  const [run, setRun] = useState<DashboardRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const now = useNow(Boolean(run));

  const refreshList = useCallback(async () => {
    try { setList(await listDashboards()); } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => { void refreshList(); }, [refreshList]);

  /* The URL says which dashboard is open, so this runs it. Same reasoning as
     the conversation route: one path into the state, so a click and a refresh
     cannot diverge. */
  useEffect(() => {
    if (openId) void open(openId);
    else setRun(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  const open = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try { setRun(await runDashboard(id)); }
    catch (e) { setError((e as Error).message); setRun(null); }
    finally { setBusy(false); }
  }, []);

  /* Re-running when the role changes is the point of the feature. Leaving the
     previous role's figures on screen under a new role would show somebody
     numbers their access does not cover. */
  useEffect(() => {
    if (openId) void open(openId);
    void refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  /**
   * Pin or unpin, optimistically.
   *
   * The card moves before the request resolves, because the point of the
   * control is that the list reorders under the cursor. On failure the previous
   * list is restored — a pin that silently did not stick is worse than one that
   * visibly bounces back.
   */
  async function togglePin(id: string, pinned: boolean) {
    const before = list;
    setList((prev) => {
      const next = prev.map((d) => (d.id === id ? { ...d, pinned } : d));
      const rank = (d: typeof next[number]) => (d.pinned ? 0 : 1);
      return [...next].sort(
        (a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt),
      );
    });
    try {
      await setDashboardPinned(id, pinned);
    } catch {
      setList(before);
    }
  }

  async function remove(id: string) {
    setConfirmId(null);
    await deleteDashboard(id);
    if (openId === id) { setRun(null); onBack(); }
    void refreshList();
  }

  const stale = useMemo(
    () => (run ? now - new Date(run.refreshedAt).getTime() > 5 * 60 * 1000 : false),
    [run, now],
  );

  /* ---------------------------------------------------------- list view */

  /* Which card is being dragged, and which it is currently over. Held here
     rather than in each Panel so only one card can be the drop target. */
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  /**
   * The authoritative source index, mirrored into a ref.
   *
   * The drop handler cannot read the state: it closes over the value from the
   * render in which it was created, and dragstart's setState only reaches a
   * later render. A pointer drag is slow enough that the re-render lands in
   * between, so this works by luck and fails the moment the two events arrive
   * in one tick — which is exactly what a synthetic drag does, and how this was
   * found. The state stays for the visuals; the ref decides what moves.
   */
  const dragFromRef = useRef<number | null>(null);
  const beginDrag = useCallback((i: number) => {
    dragFromRef.current = i;
    setDragFrom(i);
  }, []);
  const endDrag = useCallback(() => {
    dragFromRef.current = null;
    setDragFrom(null);
    setDragOver(null);
  }, []);

  /**
   * Move a panel and save the new order.
   *
   * Optimistic: the board rearranges immediately, because a drag that only
   * takes effect after a round trip feels broken. On failure the previous order
   * is restored — an arrangement that silently did not save is worse than one
   * that visibly snaps back.
   *
   * The saved order is SHARED, like the dashboard and its pin: everyone opening
   * this board sees the arrangement.
   */
  const movePanel = useCallback(async (from: number, to: number) => {
    if (!run || from === to || to < 0 || to >= run.panels.length) return;
    const before = run;
    const next = [...run.panels];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setRun({ ...run, panels: next });
    try {
      /* Ids only. Sending the panels back through updateDashboardPanels
         re-validates every statement against this viewer, so reordering a
         board containing a freight panel failed for anyone without money
         access — a permission check on SQL nobody was editing. */
      await reorderDashboardPanels(run.id, next.map((p) => p.id));
    } catch (e) {
      setRun(before);
      setError((e as Error).message);
    }
  }, [run]);

  if (!openId) {
    return (
      <div className="feat">
        <header className="feat-head">
          <div>
            <h2>Features</h2>
            <p>
              Saved dashboards. Each keeps the <strong>questions</strong> behind an
              answer and asks them again when you open it — so the figures are
              current, and scoped to what your role can see.
            </p>
          </div>
        </header>

        {error && <div className="error">{error}</div>}

        {list.length === 0 ? (
          <div className="feat-empty">
            <div className="feat-empty-mark" aria-hidden="true">
              <span /><span /><span />
            </div>
            <h3>Nothing saved yet</h3>
            <p>
              Ask something in <strong>Chat</strong>, then choose
              {' '}<strong>Create feature</strong> under the answer. It lands here and
              refreshes itself every time you open it.
            </p>
          </div>
        ) : (
          <ul className="feat-grid">
            {list.map((d) => (
              <li key={d.id} className="feat-cell">
                <button type="button" className="feat-card" onClick={() => onOpen(d.id)}>
                  <span className="feat-card-top">
                    <span className="feat-dots" aria-hidden="true">
                      {Array.from({ length: Math.min(d.panels, 6) }).map((_, i) => <i key={i} />)}
                    </span>
                    <span className="feat-count">
                      {d.panels} panel{d.panels === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="feat-name">{d.title}</span>
                  {d.description && <span className="feat-desc">{d.description}</span>}
                  <span className="feat-foot">
                    <span>{d.role.replace(/_/g, ' ').toLowerCase()}</span>
                    <span>·</span>
                    <span>{ago(d.createdAt, now)}</span>
                  </span>
                </button>

                {confirmId === d.id ? (
                  <span className="feat-confirm">
                    <button type="button" className="mini danger" onClick={() => void remove(d.id)}>
                      Delete
                    </button>
                    <button type="button" className="mini" onClick={() => setConfirmId(null)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <>
                    {/* Pinning is shared: dashboards are tenant-wide, so this
                        raises the board for everyone. The title says so, because
                        a control that quietly changes a colleague's screen
                        should say it does. */}
                    <button
                      type="button"
                      className={`feat-pin${d.pinned ? ' on' : ''}`}
                      aria-pressed={Boolean(d.pinned)}
                      aria-label={`${d.pinned ? 'Unpin' : 'Pin'} ${d.title}`}
                      title={d.pinned ? 'Unpin — for everyone' : 'Pin to the top — for everyone'}
                      onClick={() => void togglePin(d.id, !d.pinned)}
                    >
                      <IconPin filled={Boolean(d.pinned)} />
                    </button>
                    <button
                      type="button"
                      className="feat-del"
                      aria-label={`Delete ${d.title}`}
                      onClick={() => setConfirmId(d.id)}
                    >
                      ×
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  /* ----------------------------------------------------- dashboard view */
  const shown = run?.panels ?? [];
  const blocked = shown.filter((p) => p.status === 'blocked').length;

  return (
    <div className="feat">
      <div className="dash-bar">
        <button type="button" className="back" onClick={() => { setRun(null); setError(null); onBack(); }}>
          <span aria-hidden="true">←</span> Features
        </button>

        <div className="dash-id">
          {/* The list already told us the name, so there is no reason to show
              an ellipsis while the panels run. */}
          <h2>{run?.title ?? list.find((d) => d.id === openId)?.title ?? ''}</h2>
          {run?.description && <p>{run.description}</p>}
        </div>

        <div className="dash-tools">
          {run && (
            <span className={`live${stale ? ' is-stale' : ''}`} title={new Date(run.refreshedAt).toLocaleString()}>
              <i className="live-dot" aria-hidden="true" />
              {busy ? 'Refreshing…' : `Live · ${ago(run.refreshedAt, now)}`}
            </span>
          )}
          <button type="button" className="refresh" onClick={() => void open(openId)} disabled={busy}>
            <span className={busy ? 'spin' : undefined} aria-hidden="true">⟳</span>
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {blocked > 0 && (
        <div className="dash-note">
          {blocked} of {shown.length} panels are not shown — they use data your role
          cannot see. Everything else on this page is yours.
        </div>
      )}

      <div className="dash-grid">
        {busy && !run
          ? Array.from(
              { length: Math.min(list.find((d) => d.id === openId)?.panels ?? 2, 6) },
              (_, i) => <Skeleton key={i} />,
            )
          : (() => {
              const ordered = forDisplay(shown);
              const spans = fillRows(ordered.map((p) => spanFor(p, shapeOf(p))));
              return ordered.map((p, i) => (
                <Panel
                  key={p.id}
                  p={p}
                  mode={mode}
                  role={role}
                  span={spans[i]}
                  /* Reordering is off while a refresh is in flight: the board
                     is about to be replaced by the server's copy anyway, and a
                     drag landing in that gap would be lost without explanation. */
                  drag={busy ? undefined : {
                    index: i,
                    count: ordered.length,
                    isDragging: dragFrom === i,
                    isOver: dragOver === i && dragFrom !== null && dragFrom !== i,
                    onStart: beginDrag,
                    onOver: setDragOver,
                    onDrop: (to) => {
                      const from = dragFromRef.current;
                      if (from !== null) void movePanel(from, to);
                      endDrag();
                    },
                    onEnd: endDrag,
                    onMove: (from, to) => void movePanel(from, to),
                  }}
                />
              ));
            })()}
      </div>

      {run && (
        <p className="dash-prov">
          Saved by <strong>{run.createdBy}</strong> · every panel re-ran just now
          under your own access, and each run is written to the audit log.
        </p>
      )}
    </div>
  );
}

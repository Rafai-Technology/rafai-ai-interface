import type { ChartSpec, TraceStep } from './types';

// Models label the block inconsistently — chart, json, or nothing. Accept any
// fenced block that parses into something with the shape of a chart spec.
const FENCE = /```(\w+)?\s*([\s\S]*?)```/g;

export interface ParsedAnswer {
  text: string;
  chart: ChartSpec | null;
}

/**
 * The model returns prose plus an optional ```chart fenced JSON block. It never
 * returns the data — the numbers come from the trace, so nothing plotted here
 * has passed back through the model.
 */
export function parseAnswer(answer: string): ParsedAnswer {
  let chart: ChartSpec | null = null;
  let text = answer;

  FENCE.lastIndex = 0;
  for (const match of answer.matchAll(FENCE)) {
    const [block, , body] = match;
    let spec: any;
    try {
      spec = JSON.parse(body.trim());
    } catch {
      continue; // not JSON — a SQL or code block, leave it in the prose
    }
    if (!spec || typeof spec.x !== 'string' || !spec.y) continue;

    chart = {
      type: spec.type === 'line' || spec.type === 'pie' ? spec.type : 'bar',
      x: spec.x,
      y: Array.isArray(spec.y) ? spec.y : [spec.y].filter(Boolean),
      title: spec.title,
    };
    text = text.replace(block, '');
    break;
  }

  return { text: text.trim(), chart };
}

/**
 * Finds the retrieved rows the spec is describing: the last successful query
 * whose columns actually contain the axes the model named. Matching on columns
 * rather than assuming the last query avoids plotting one query's spec against
 * another query's rows.
 */
export function rowsForChart(
  trace: TraceStep[],
  chart: ChartSpec,
): Record<string, any>[] | null {
  const usable = trace.filter(
    (s) => s.status === 'ok' && Array.isArray(s.rows) && s.rows.length > 0,
  );
  for (let i = usable.length - 1; i >= 0; i--) {
    const rows = usable[i].rows!;
    const columns = Object.keys(rows[0]);
    if (columns.includes(chart.x) && chart.y.every((y) => columns.includes(y))) {
      return rows;
    }
  }
  return null;
}

const LOOKS_NUMERIC = (v: any) =>
  v !== null && v !== '' && Number.isFinite(Number(v));

/**
 * Builds a chart spec from the retrieved rows when the model did not supply
 * one. Weaker models emit the spec inconsistently — sometimes fenced as json,
 * sometimes described in prose, sometimes not at all — and whether a result is
 * chartable is a property of the data, not of the model's mood.
 */
/**
 * Takes precedence over whatever spec the model wrote. Asked to chart a
 * forecast, models reach for a plain line of the projected points alone —
 * dropping the history it grew out of and the interval around it, which are
 * the two things that make a projection readable.
 */
export function forecastChart(trace: TraceStep[]): ChartSpec | null {
  const projection = [...trace].reverse().find(
    (s) => s.tool === 'run_forecast' && s.status === 'ok' && s.rows?.length,
  );
  if (!projection) return null;
  return {
    type: 'forecast',
    x: 'period',
    y: ['actual', 'forecast'],
    title: 'Projection, with confidence interval',
  };
}

export function inferChart(trace: TraceStep[]): ChartSpec | null {
  const step = [...trace].reverse().find(
    (s) =>
      s.status === 'ok' &&
      Array.isArray(s.rows) &&
      s.rows.length >= 3 &&
      /* diagnose_process carries the funnel on its trace so the step is
         inspectable, but those rows are not a chart: inferring one produced a
         single bar labelled "drop from previous by stage" underneath a findings
         panel that had already said it in words. The findings ARE the render. */
      s.tool !== 'diagnose_process',
  );
  if (!step?.rows) return null;

  const rows = step.rows;
  const columns = Object.keys(rows[0] ?? {});
  const label = columns.find((c) => rows.every((r) => !LOOKS_NUMERIC(r[c])));
  const numeric = columns.filter((c) => rows.every((r) => LOOKS_NUMERIC(r[c])));
  if (!label || !numeric.length) return null;

  // With both a count and an amount present, the amount is what the question
  // was about: "outstanding by ageing" means the money, not the invoice count.
  const MAGNITUDE = /amount|outstanding|revenue|value|total|cost|profit|freight|weight|km|balance/i;

  /**
   * An EXTREME is not a magnitude, and charting one lies about the shape.
   *
   * Asked how many consignments are in transit, the answer tabled a count and
   * an average age per status — and the chart drew MAX age, because that was
   * simply the last numeric column. The tallest bar became the status with one
   * old outlier rather than the one with the most consignments, which is the
   * opposite of what the reader was being told in the prose beside it.
   */
  const EXTREME = /^(max|min|oldest|newest|longest|shortest|worst|best)[_ ]|_(max|min)$/i;
  /** What a breakdown is almost always about when no money column is present. */
  const COUNT = /^(n|count|consignments|shipments|rows|total_[a-z_]*count)$|count|_count$/i;

  const usable = numeric.filter((c) => !EXTREME.test(c));
  const pool = usable.length ? usable : numeric;
  const value =
    pool.find((c) => MAGNITUDE.test(c)) ??
    pool.find((c) => COUNT.test(c)) ??
    pool[pool.length - 1];

  // A month-keyed series is a trend; anything else is a comparison.
  const temporal = /month|date|period|day|week|year/i.test(label);
  return {
    type: temporal ? 'line' : 'bar',
    x: label,
    y: [value],
    title: `${value.replace(/_/g, ' ')} by ${label.replace(/_/g, ' ')}`,
  };
}

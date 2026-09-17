import type { AnswerScope, ChartSpec, ScopeCounts, TraceStep } from './types';

// Models label the block inconsistently — chart, json, or nothing. Accept any
// fenced block that parses into something with the shape of a chart spec.
const FENCE = /```(\w+)?\s*([\s\S]*?)```/g;

/** A suggested next question; `insight` marks the one that showcases analysis. */
export interface FollowUp {
  text: string;
  insight: boolean;
}

export interface ParsedAnswer {
  text: string;
  chart: ChartSpec | null;
  /** Next questions the model suggests, shown as buttons under the answer. */
  followups: FollowUp[];
  /** The period a list was filtered to, shown above the answer. */
  scope: AnswerScope | null;
}

const SCOPE = /```scope\s*([\s\S]*?)```/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pulls the ```scope block out of an answer. Only a label is required; a
 * malformed block is dropped without a header rather than shown half-built.
 */
function takeScope(answer: string): { text: string; scope: AnswerScope | null } {
  const match = SCOPE.exec(answer);
  if (!match) return { text: answer, scope: null };
  const text = answer.replace(match[0], '');
  try {
    const raw = JSON.parse(match[1].trim());
    if (!raw || typeof raw.label !== 'string' || !raw.label.trim()) return { text, scope: null };
    const date = (v: unknown) => (typeof v === 'string' && ISO_DATE.test(v) ? v : undefined);
    return {
      text,
      scope: {
        label: raw.label.trim().slice(0, 60),
        from: date(raw.from),
        to: date(raw.to),
        noun: typeof raw.noun === 'string' && raw.noun.trim() ? raw.noun.trim().slice(0, 40) : undefined,
        isDefault: raw.default === true,
      },
    };
  } catch {
    return { text, scope: null };
  }
}

/**
 * The counts for the header, from the list query's own rows — never from the
 * prose, for the same reason the chart is drawn from rows: a figure the model
 * retyped is a figure that can be retyped wrong.
 *
 * Takes the last successful query that returned period_count or total_all.
 */
export function scopeCounts(trace: TraceStep[]): ScopeCounts | null {
  const num = (v: unknown) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  for (let i = trace.length - 1; i >= 0; i--) {
    const step = trace[i];
    const first = step.status === 'ok' ? step.rows?.[0] : undefined;
    if (!first) continue;
    const inPeriod = num(first.period_count);
    const total = num(first.total_all);
    if (inPeriod === undefined && total === undefined) continue;
    return { inPeriod, total, returned: step.rowCount ?? step.rows?.length };
  }
  return null;
}

const FOLLOWUPS = /```followups\s*([\s\S]*?)```/;

/**
 * Pulls the ```followups block out of an answer.
 *
 * Items are strings, or {"text", "insight": true} for the highlighted one.
 * Anything else yields no button: a click sends the text as a question, so a
 * stray object or number must never reach the composer. Capped at three, the
 * most the model is asked for, de-duplicated, with at most one insight.
 */
function takeFollowups(answer: string): { text: string; followups: FollowUp[] } {
  const match = FOLLOWUPS.exec(answer);
  if (!match) return { text: answer, followups: [] };
  const text = answer.replace(match[0], '');
  try {
    const parsed = JSON.parse(match[1].trim());
    if (!Array.isArray(parsed)) return { text, followups: [] };
    const followups: FollowUp[] = [];
    for (const q of parsed) {
      const raw = typeof q === 'string' ? q : q && typeof q.text === 'string' ? q.text : null;
      const question = raw?.trim();
      if (!question || question.length > 200) continue;
      if (followups.some((f) => f.text === question)) continue;
      const insight =
        typeof q === 'object' && q.insight === true && !followups.some((f) => f.insight);
      followups.push({ text: question, insight });
      if (followups.length === 3) break;
    }
    /* There is always one highlighted question. Answers where the model marked
       none (saved before the rule, or it forgot) highlight the last, which is
       where the prompt puts the insight. */
    if (followups.length && !followups.some((f) => f.insight)) {
      followups[followups.length - 1].insight = true;
    }
    return { text, followups };
  } catch {
    return { text, followups: [] };
  }
}

/**
 * The model returns prose plus an optional ```chart fenced JSON block. It never
 * returns the data — the numbers come from the trace, so nothing plotted here
 * has passed back through the model.
 */
/** Every form the renderer can draw from a model-supplied spec. 'forecast' is
 *  deliberately absent: it is derived from a run_forecast trace step, never
 *  requested, so accepting it here would let a spec claim an interval that was
 *  never computed. */
const CHART_TYPES = new Set<ChartSpec['type']>([
  'bar', 'hbar', 'line', 'stacked', 'pie', 'scatter', 'pareto',
]);

/**
 * DeepSeek's tool-call markup, written as text by mistake. The service strips
 * it now, but answers saved before that still carry it, and it must not be
 * rendered as prose. Always the tail of a message, often unclosed.
 */
const TOOL_CALL_MARKUP = /<｜(?:DSML｜|tool▁calls▁begin｜>|tool▁call▁begin｜>)[\s\S]*$/;

export function parseAnswer(answer: string): ParsedAnswer {
  answer = answer.replace(TOOL_CALL_MARKUP, '');
  let chart: ChartSpec | null = null;
  const taken = takeFollowups(answer);
  const scoped = takeScope(taken.text);
  let text = scoped.text;

  FENCE.lastIndex = 0;
  for (const match of scoped.text.matchAll(FENCE)) {
    const [block, , body] = match;
    let spec: any;
    try {
      spec = JSON.parse(body.trim());
    } catch {
      continue; // not JSON — a SQL or code block, leave it in the prose
    }
    if (!spec || typeof spec.x !== 'string' || !spec.y) continue;

    chart = {
      /* An allowlist, not a pass-through: the model is free to invent a type
         name, and an unknown one must land on a form that always renders
         rather than on an empty card. Everything unrecognised becomes a bar,
         which is the safe default for "magnitude across categories".

         This list has to be kept in step with ChartSpec. It silently pinned
         every answer to bar/line/pie for as long as it said only those three —
         stacked, pareto and scatter specs parsed fine and were then thrown
         away one line later. */
      type: CHART_TYPES.has(spec.type) ? spec.type : 'bar',
      x: spec.x,
      y: Array.isArray(spec.y) ? spec.y : [spec.y].filter(Boolean),
      title: spec.title,
    };
    text = text.replace(block, '');
    break;
  }

  return { text: text.trim(), chart, followups: taken.followups, scope: scoped.scope };
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

export interface TraceStep {
  tool: string;
  intent?: string;
  sql?: string;
  rowCount?: number;
  durationMs?: number;
  status: 'ok' | 'blocked' | 'error' | 'suppressed';
  reason?: string;
  rows?: Record<string, any>[];
  /** diagnose_process only: measured process findings, each with its own
   *  evidence and a recommendation anchored to a real benchmark. */
  findings?: Finding[];
  /**
   * search_business_logic only: the actual (possibly truncated) source of
   * every stored procedure/function the model was shown, so this is
   * verifiable the same way a SQL query is — never just a name to trust.
   */
  logicSources?: { name: string; type: string; truncated: boolean; definition: string }[];
  /**
   * export_result only: what the user asked to be exported. Carries no file —
   * the browser builds it from rows already elsewhere in this same trace.
   */
  exportRequest?: {
    format: 'csv' | 'pdf' | 'png';
    title: string;
    /** The finding, for a reader who never saw the conversation. */
    summary?: string;
    /** Qualifications rendered into the PDF alongside the figures. */
    caveats?: string[];
  };
}

export interface Conversation {
  /** Kept at the top of the list, above the paged remainder. */
  pinned?: boolean;
  id: string;
  title: string;
  turns: number;
  /** Files attached to this thread. Drives the paperclip in the list — the
   *  indicator used to be an emoji stored inside the title, which meant a
   *  rename silently removed it. Optional: an older server does not send it. */
  attachments?: number;
  updatedAt: string;
}

/** A page of threads. `nextCursor` is null at the end of the list. */
export interface ConversationPage {
  items: Conversation[];
  nextCursor: string | null;
}

export interface AskResult {
  answer: string;
  trace: TraceStep[];
  hops: number;
  usage: { input: number; output: number; cacheRead: number };
  /** Which thread the turn landed in — set by the server on every ask. */
  conversation_id?: string | null;
  /** The stored turn just created, so it can be edited or re-run without
   *  refetching the thread. Null if the history write failed. */
  turn_id?: string | null;
  /** Files attached to this conversation that were actually placed in the
   *  model's context for this turn — shown for the same reason SQL is shown:
   *  every source the answer could see should be visible, not just trusted. */
  attachments?: { filename: string; kind: string; truncated: boolean }[];
}

/** A file attached to a conversation. Mirrors HistoryAttachment on the server
 *  — never carries the extracted text over the wire, only what the UI needs
 *  to render a chip. */
export interface Attachment {
  id: string;
  filename: string;
  kind: 'csv' | 'xlsx' | 'txt';
  rows: number | null;
  truncated: boolean;
  bytes: number;
  createdAt: string;
}

/** The period a list answer was filtered to, as written by the model. It
 *  carries no counts: those are read from the retrieved rows. */
export interface AnswerScope {
  label: string;
  /** First day included, YYYY-MM-DD. */
  from?: string;
  /** Last day included, YYYY-MM-DD. */
  to?: string;
  /** What was listed — "consignments", "dispatches". */
  noun?: string;
  /** True when no period was asked for and the default window was applied. */
  isDefault: boolean;
}

/** Counts behind a scoped list, read off the query's own rows. */
export interface ScopeCounts {
  /** Every record in the period, counted before the row cap. */
  inPeriod?: number;
  /** Every record with no date filter. */
  total?: number;
  /** Rows the list query actually returned. */
  returned?: number;
}

export interface ChartSpec {
  /**
   * Forms deliberately excluded, so the next person does not re-add them:
   *  - dual-axis (bar + line on two y-scales) is the single most common chart
   *    mistake; two measures at different scales become small multiples here,
   *    which needsSmallMultiples() already does automatically.
   *  - stacked AREA, because comparing a middle band against a moving baseline
   *    is not something anyone can do by eye.
   */
  type:
    | 'bar'
    /** Horizontal bars. Same encoding as bar, but category labels get a real
     *  gutter instead of being rotated or truncated — which is most ranking
     *  answers here, where the labels are branch, customer and vendor names. */
    | 'hbar'
    | 'line'
    /** Parts of a whole across a category or a period. Only valid when every
     *  series shares a unit; unit-mismatched series must stay separate. */
    | 'stacked'
    | 'pie'
    /** Two NUMERIC columns against each other — cost against weight, load
     *  against capacity. The only form here that does not need a categorical
     *  label column, and the only one that shows a relationship rather than a
     *  ranking. */
    | 'scatter'
    /** Ranked share with a cumulative curve: "which few things are most of the
     *  total". Both marks are percentages on ONE axis — never a count axis and
     *  a percent axis together. */
    | 'pareto'
    | 'forecast';
  x: string;
  y: string[];
  title?: string;
}

/**
 * Mirrors PermissionsService.describeAll() exactly. It previously carried a
 * `db_role` that the backend had stopped sending — TypeScript believed the
 * declaration, so the mismatch surfaced as a runtime crash instead of a
 * compile error. Keep this in step with the API.
 */
export interface RoleInfo {
  role: string;
  label: string;
  description: string;
  /** Rule set the role inherits: full, accounts, branch, operations, ... */
  profile: string | null;
  branch_scope: 'ALL' | 'BRANCH';
  areas: string[];
  /** ALL = company-wide rupee figures, BRANCH = own branch only, NONE = never. */
  money: 'ALL' | 'BRANCH' | 'NONE';
  max_rows: number;
  live: boolean;
  active_users: number;
  questions: string[];
}

export interface HistoryTurn {
  id: string;
  question: string;
  answer: string;
  hops: number;
  trace: TraceStep[];
  createdAt: string;
}

export interface Turn {
  id: string;
  question: string;
  role: string;
  /**
   * The stored turn this bubble corresponds to, when there is one.
   *
   * Editing and re-running both replace a stored exchange, so both need the
   * server's id — a local key is not addressable. Absent means the turn was
   * never written (the history write failed), and the controls are correctly
   * not offered rather than offered and broken.
   */
  turnId?: string | null;
  /** Files that were attached when this question was sent, shown on the
   *  message itself so the composer can be cleared without losing the record
   *  of what went with it. */
  sentAttachments?: Attachment[];
  result?: AskResult;
  error?: string;
  pending: boolean;
  /**
   * What has arrived so far while the answer is streaming. `steps` is text
   * written alongside earlier tool calls, kept on screen; `text` is what is
   * being written now; `tool` and `intent` describe the step running, and
   * `writing` is true while text is arriving. Dropped once `result` lands.
   */
  live?: {
    steps: string[];
    text: string;
    tool?: string;
    intent?: string;
    writing?: boolean;
    /** The one-line acknowledgement, shown above the loader. */
    ack?: string;
  };
}

export interface Tile {
  key: string;
  label: string;
  caption: string;
  value: number | null;
  format: 'int' | 'inr' | 'pct';
  tone: 'neutral' | 'good' | 'warning' | 'critical';
  module: string;
  question: string;
}

/* ---------------------------------------------------------------- features */

/**
 * A saved dashboard panel, as sent to the server.
 *
 * Note what is NOT here: rows. A panel stores the query and the chart spec, and
 * the server re-runs the query every time the dashboard is opened. Sending rows
 * would freeze the figure at the moment it was saved — and would replay data
 * fetched under one person's branch scope to whoever opened it next.
 */
export interface NewPanel {
  title: string;
  sql: string;
  chartSpec?: ChartSpec | null;
  caveats?: string[];
}

export interface DashboardSummary {
  id: string;
  /** Raised to the top of the list. SHARED across the tenant — dashboards are
   *  everybody's here, so pinning one is a statement about the company rather
   *  than a personal bookmark. */
  pinned?: boolean;
  title: string;
  description: string | null;
  userId: string;
  role: string;
  panels: number;
  createdAt: string;
  updatedAt: string;
}

/** One panel's result, produced by the server at the moment of the request. */
export interface DashboardPanelResult {
  id: string;
  title: string;
  sql: string;
  chartSpec: ChartSpec | null;
  caveats: string[];
  status: 'ok' | 'blocked' | 'error';
  reason?: string;
  rows: Record<string, any>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

export interface DashboardRun {
  id: string;
  title: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
  sourceConversationId: string | null;
  /** Server-stamped, so "as of" is when the data was fetched. */
  refreshedAt: string;
  panels: DashboardPanelResult[];
}

/** A dashboard's stored definition — the queries, not their results. */
export interface DashboardDefinition {
  id: string;
  title: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  sourceConversationId: string | null;
  panels: {
    id: string;
    position: number;
    title: string;
    sql: string;
    chartSpec: ChartSpec | null;
    caveats: string[];
  }[];
}

/** The verified principal, straight from the server. */
export interface Me {
  tenant_id: string;
  user_id: string;
  role: string;
  all_branches: boolean;
  branch_ids: number[];
  branch_scope: 'ALL' | 'BRANCH';
}

/** One measured problem, what it costs, and what to do — from diagnose_process.
 *  Every field is computed server-side from SQL, never written by the model. */
export interface Finding {
  id: string;
  severity: 'critical' | 'high' | 'medium';
  title: string;
  /** The one figure the finding is about, split out of its prose so the panel
   *  can set it once and large. */
  headline: { value: string; label: string } | null;
  delta: { value: string; direction: 'up' | 'down'; is_good: boolean } | null;
  measured: string;
  trend: string | null;
  benchmark: string | null;
  impact: string;
  recommendation: string;
  evidence: string[];
}

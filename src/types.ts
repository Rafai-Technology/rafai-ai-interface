export interface TraceStep {
  tool: string;
  intent?: string;
  sql?: string;
  rowCount?: number;
  durationMs?: number;
  status: 'ok' | 'blocked' | 'error' | 'suppressed';
  reason?: string;
  rows?: Record<string, any>[];
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
  id: string;
  title: string;
  turns: number;
  updatedAt: string;
}

export interface AskResult {
  answer: string;
  trace: TraceStep[];
  hops: number;
  usage: { input: number; output: number; cacheRead: number };
  /** Which thread the turn landed in — set by the server on every ask. */
  conversation_id?: string | null;
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

export interface ChartSpec {
  type: 'bar' | 'line' | 'pie' | 'forecast';
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
  /** Files that were attached when this question was sent, shown on the
   *  message itself so the composer can be cleared without losing the record
   *  of what went with it. */
  sentAttachments?: Attachment[];
  result?: AskResult;
  error?: string;
  pending: boolean;
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

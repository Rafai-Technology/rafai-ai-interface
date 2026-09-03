import type {
  Attachment, AskResult, ConversationPage, DashboardDefinition, DashboardRun,
  DashboardSummary, HistoryTurn, Me, NewPanel, RoleInfo, Tile,
} from './types';

const TOKEN_KEY = 'rafai-ai-token';

/**
 * Where the agent service lives.
 *
 * Defaults to '/api', which covers the two deployments that keep the browser
 * on one origin: the Vite dev proxy, and a reverse proxy putting the API under
 * /api in production. Set VITE_API_BASE_URL to a full origin
 * (https://agent.example.com) when the frontend is hosted separately from the
 * service — the backend must then allow that origin in CORS_ORIGINS.
 *
 * Trailing slashes are trimmed so a value of "https://x/" cannot produce "//".
 */
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/+$/, '');

/** Build a URL against the configured API base. */
function url(path: string): string {
  return `${API_BASE}${path}`;
}

let token: string | null = localStorage.getItem(TOKEN_KEY);

export function currentToken(): string | null {
  return token;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    let message = body;
    try {
      message = JSON.parse(body).message ?? body;
    } catch {
      /* not JSON; use the raw body */
    }
    throw new Error(message || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export async function listRoles(): Promise<RoleInfo[]> {
  return json<RoleInfo[]>(await fetch(url('/auth/roles'), { method: 'POST' }));
}

/**
 * Demo-only. In production the ERP issues the JWT and the agent service only
 * verifies it — there is no endpoint that hands out a role on request.
 */
export async function switchRole(role: string, branchIds?: number[]): Promise<void> {
  const res = await fetch(url('/auth/demo-token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role, branch_ids: branchIds }),
  });
  const data = await json<{ access_token: string }>(res);
  token = data.access_token;
  localStorage.setItem(TOKEN_KEY, token);
}

export async function ask(
  question: string,
  conversationId: string | null,
  /** Replace this stored turn and everything after it, instead of appending —
   *  used when a question is edited, or re-run for a different answer. */
  replaceTurnId?: string | null,
): Promise<AskResult> {
  const res = await fetch(url('/agent/ask'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      question,
      conversation_id: conversationId,
      ...(replaceTurnId ? { replace_turn_id: replaceTurnId } : {}),
    }),
  });
  return json<AskResult>(res);
}

export async function schema(): Promise<{ role: string; views: string[] }> {
  const res = await fetch(url('/agent/schema'), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return json(res);
}

export async function overview(): Promise<Tile[]> {
  const res = await fetch(url('/agent/overview'), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return json<Tile[]>(res);
}

/**
 * One page of threads, newest first.
 *
 * Cursor-paged rather than offset-paged: the list reorders itself every time an
 * answer lands, so an offset would skip or repeat whatever moved while the user
 * was reading. Pass the previous `nextCursor` to get the next page; a null one
 * means the end.
 */
export async function conversations(
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<ConversationPage> {
  const q = new URLSearchParams();
  if (opts.limit) q.set('limit', String(opts.limit));
  if (opts.cursor) q.set('cursor', opts.cursor);
  const res = await fetch(url(`/agent/conversations${q.toString() ? `?${q}` : ''}`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return json<ConversationPage>(res);
}

export async function conversationTurns(id: string): Promise<HistoryTurn[]> {
  const res = await fetch(url(`/agent/conversations/${id}`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return json<HistoryTurn[]>(res);
}

export async function setPinned(id: string, pinned: boolean): Promise<void> {
  const res = await fetch(url(`/agent/conversations/${id}`), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  await json<{ pinned: boolean }>(res);
}

export async function deleteConversation(id: string): Promise<void> {
  await fetch(url(`/agent/conversations/${id}`), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * No content-type header here on purpose — the browser sets the multipart
 * boundary itself from the FormData body, and overriding it breaks the parse.
 */
export async function uploadAttachment(
  file: File,
  conversationId: string | null,
): Promise<{ conversation_id: string; attachment: Attachment }> {
  const form = new FormData();
  form.append('file', file);
  if (conversationId) form.append('conversation_id', conversationId);

  const res = await fetch(url('/agent/attachments'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return json(res);
}

export async function deleteAttachment(
  conversationId: string,
  attachmentId: string,
): Promise<void> {
  const res = await fetch(
    url(`/agent/conversations/${conversationId}/attachments/${attachmentId}`),
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
  // Surfaced rather than swallowed: if the delete failed the file is still in
  // the model's context, and showing the chip as gone would be a lie.
  if (!res.ok) await json(res);
}

export async function listAttachments(conversationId: string): Promise<Attachment[]> {
  const res = await fetch(url(`/agent/conversations/${conversationId}/attachments`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return json<Attachment[]>(res);
}

/* ---------------------------------------------------------------- features */

/**
 * Saved dashboards.
 *
 * `runDashboard` is a POST because opening a dashboard is not a read of stored
 * state — it executes every panel against the customer's database, under the
 * caller's own role and branch scope, and writes an audit row for each. The
 * rows come back fresh every time; nothing about them is cached, here or on
 * the server.
 */
export async function listDashboards(): Promise<DashboardSummary[]> {
  const res = await fetch(url('/dashboards'), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return json<DashboardSummary[]>(res);
}

export async function createDashboard(body: {
  title: string;
  description?: string;
  conversation_id?: string | null;
  panels: NewPanel[];
}): Promise<{ id: string }> {
  const res = await fetch(url('/dashboards'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return json<{ id: string }>(res);
}

export async function runDashboard(id: string): Promise<DashboardRun> {
  const res = await fetch(url(`/dashboards/${id}/run`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  return json<DashboardRun>(res);
}

/**
 * A dashboard's definition, without running it.
 *
 * Use this for an edit screen or anywhere the name and queries are wanted but
 * the figures are not — `runDashboard` executes every panel against the
 * customer's database and writes an audit row per panel.
 */
export async function getDashboard(id: string): Promise<DashboardDefinition> {
  const res = await fetch(url(`/dashboards/${id}`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return json<DashboardDefinition>(res);
}

/** Replaces the panels — how a saved query gets corrected. */
export async function updateDashboardPanels(
  id: string,
  panels: NewPanel[],
): Promise<{ id: string; panels: number }> {
  const res = await fetch(url(`/dashboards/${id}/panels`), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ panels }),
  });
  return json<{ id: string; panels: number }>(res);
}

export async function renameDashboard(id: string, title: string): Promise<void> {
  const res = await fetch(url(`/dashboards/${id}`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error('Could not rename that dashboard');
}

/**
 * Who the server says you are.
 *
 * Prefer this over decoding the JWT in the browser: a client-side decode is
 * unverified, so it yields a claim rather than a fact, and it is the server's
 * copy that every access decision is actually made from.
 */
export async function me(): Promise<Me> {
  const res = await fetch(url('/auth/me'), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return json<Me>(res);
}

export async function health(): Promise<{ status: string; control_store: string; time: string }> {
  return json(await fetch(url('/health')));
}

export async function deleteDashboard(id: string): Promise<void> {
  const res = await fetch(url(`/dashboards/${id}`), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Could not delete that dashboard');
}

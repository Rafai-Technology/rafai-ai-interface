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
 *
 * `||`, not `??`: the Dockerfile declares the variable with an empty default,
 * and an empty string survives `??` — every request then went to /auth/...
 * instead of /api/auth/... and the containerised app could not sign in.
 */
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/+$/, '');

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
  /**
   * A successful response with no body is a success, not a parse error.
   *
   * PUT /dashboards/:id/panels replaces the panels and returns 204 No Content,
   * which is correct — there is nothing to send back. Calling res.json() on it
   * throws "Failed to fetch", and the caller, seeing a rejected promise, undoes
   * the change it had just made optimistically. Reordering a dashboard looked
   * like it silently refused, while the server had already saved it.
   *
   * Checked on the body rather than only on 204, because a 200 with an empty
   * body fails in exactly the same way.
   */
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
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

/**
 * The connection died before the response arrived — the browser's bare
 * "Failed to fetch". Distinguished from every other failure because it is the
 * one where the request may well have SUCCEEDED: a long answer can outlive a
 * reverse proxy's read timeout, and the service, which never learns the socket
 * closed, finishes the work and stores the turn regardless. Reporting that as
 * an error loses an answer that exists. See recoverAskResult.
 */
export class ConnectionLostError extends Error {
  constructor() {
    super(
      'The connection dropped before the answer arrived. The answer may still ' +
        'have been saved — reopen this conversation to check.',
    );
    this.name = 'ConnectionLostError';
  }
}

export async function ask(
  question: string,
  conversationId: string | null,
  /** Replace this stored turn and everything after it, instead of appending —
   *  used when a question is edited, or re-run for a different answer. */
  replaceTurnId?: string | null,
): Promise<AskResult> {
  let res: Response;
  try {
    res = await fetch(url('/agent/ask'), {
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
  } catch {
    // fetch only rejects on a network-level failure; an HTTP error status
    // resolves normally and is handled by json() below. So reaching here means
    // the socket, not the service, gave up.
    throw new ConnectionLostError();
  }
  return json<AskResult>(res);
}

/** Progress of a streamed ask, as sent by POST /agent/ask/stream. */
export interface AskStreamHandlers {
  /** A tool is about to run; `intent` is the model's one-line description. */
  onStatus?: (tool: string, intent?: string) => void;
  /** The next piece of the reply. */
  onText?: (delta: string) => void;
  /** Text shown so far was a step, not the answer — discard it. */
  onReset?: () => void;
  /** The first step's text was the one-line acknowledgement; keep it on top. */
  onAck?: (text: string) => void;
}

/**
 * The same exchange as ask(), with the reply arriving as it is written.
 *
 * Read with fetch rather than EventSource: EventSource can only GET and cannot
 * send the Authorization header. Resolves with the same AskResult ask() does,
 * so everything after the answer lands is unchanged.
 *
 * A stream that ends without `done` or `error` is treated exactly like a
 * dropped connection — the service keeps working and saves the turn, so the
 * caller's recovery path applies.
 */
export async function askStream(
  question: string,
  conversationId: string | null,
  replaceTurnId: string | null | undefined,
  handlers: AskStreamHandlers,
): Promise<AskResult> {
  let res: Response;
  try {
    res = await fetch(url('/agent/ask/stream'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        question,
        conversation_id: conversationId,
        ...(replaceTurnId ? { replace_turn_id: replaceTurnId } : {}),
      }),
    });
  } catch {
    throw new ConnectionLostError();
  }
  // Validation and auth failures arrive before the stream opens, as plain JSON.
  if (!res.ok || !res.body) return json<AskResult>(res);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value.replace(/\r\n/g, '\n');

      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);

        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trimStart();
          // Lines starting with ':' are heartbeats.
        }
        if (!data) continue;
        const payload = JSON.parse(data);

        switch (event) {
          case 'status': handlers.onStatus?.(payload.tool, payload.intent); break;
          case 'text': handlers.onText?.(payload.delta); break;
          case 'reset': handlers.onReset?.(); break;
          case 'ack': handlers.onAck?.(payload.text); break;
          case 'done': return payload as AskResult;
          case 'error': throw new Error(payload.message || 'The request failed.');
        }
      }
    }
  } catch (e) {
    if (e instanceof Error && !(e instanceof TypeError)) throw e;
    // A TypeError here is the socket failing mid-read.
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new ConnectionLostError();
}

/**
 * Looks for the answer to a question whose request died in transit.
 *
 * The service stores the turn when it finishes, so the answer usually appears
 * shortly after the browser has given up waiting for it. Polls the thread
 * until it does.
 *
 * Two conditions have to hold before a turn is accepted as the missing one,
 * and both matter. It must be the LAST turn in the thread, and its id must be
 * one the client has not seen. Matching on the question text alone would
 * happily return a months-old answer to the same question asked twice, which
 * is a worse failure than the error it replaces — a stale figure presented as
 * a fresh one.
 */
export async function recoverAskResult(
  conversationId: string | null,
  question: string,
  knownTurnIds: string[],
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<AskResult | null> {
  const attempts = opts.attempts ?? 12;
  const delayMs = opts.delayMs ?? 5000;
  const wanted = question.trim();
  const seen = new Set(knownTurnIds);

  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      // A first message has no conversation id yet — the thread was created by
      // the very request that was lost. Threads list newest-first, so the one
      // just created is at the top; the question check below is what actually
      // confirms it, the position only decides where to look.
      const id =
        conversationId ?? (await conversations({ limit: 1 })).items[0]?.id ?? null;
      if (!id) continue;

      const turns = await conversationTurns(id);
      const last = turns[turns.length - 1];
      if (!last || seen.has(last.id) || last.question.trim() !== wanted) continue;

      return {
        answer: last.answer,
        trace: last.trace,
        hops: last.hops,
        // Not recoverable from storage, and not worth a second endpoint: the
        // token counters are per-request telemetry, and this request is over.
        usage: { input: 0, output: 0, cacheRead: 0 },
        conversation_id: id,
        turn_id: last.id,
      };
    } catch {
      // The thread read failed too — probably the same underlying outage.
      // Keep polling; giving up here would discard an answer that may land a
      // few seconds later.
    }
  }
  return null;
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

/** Moves panels. Positions only — no SQL is re-validated, so a viewer can
 *  arrange a board they would not be allowed to author. */
export async function reorderDashboardPanels(id: string, order: string[]): Promise<void> {
  const res = await fetch(url(`/dashboards/${id}/panels/order`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ order }),
  });
  await json<{ ok: boolean }>(res);
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

export async function setDashboardPinned(id: string, pinned: boolean): Promise<void> {
  const res = await fetch(url(`/dashboards/${id}`), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  await json<{ ok: boolean }>(res);
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

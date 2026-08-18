import type {
  Attachment, AskResult, Conversation, HistoryTurn, RoleInfo, Tile,
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
): Promise<AskResult> {
  const res = await fetch(url('/agent/ask'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ question, conversation_id: conversationId }),
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

export async function conversations(): Promise<Conversation[]> {
  const res = await fetch(url('/agent/conversations'), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return json<Conversation[]>(res);
}

export async function conversationTurns(id: string): Promise<HistoryTurn[]> {
  const res = await fetch(url(`/agent/conversations/${id}`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return json<HistoryTurn[]>(res);
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

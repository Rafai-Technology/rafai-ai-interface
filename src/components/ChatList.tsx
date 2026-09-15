import { useEffect, useRef } from 'react';
import type { Conversation } from '../types';
import { IconPin, IconPlus, IconTrash, IconFile } from './icons';

interface Props {
  chats: Conversation[];
  activeId: string | null;
  busy: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
}

/** "3m", "4h", "2d" — enough to place a thread without a date column. */
function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function ChatList({
  chats, activeId, busy, onNew, onOpen, onDelete, onTogglePin, onLoadMore, hasMore, loadingMore,
}: Props) {
  const sentinel = useRef<HTMLDivElement>(null);

  /**
   * One flat list with headings, not two lists.
   *
   * The server returns pinned rows first, so the split is a scan rather than a
   * sort — and keeping them in a single <ul> means the paging sentinel at the
   * bottom still sees the whole scroll container. Headings only appear when
   * there is actually a pinned row to separate; an unused "Recent" label above
   * a list with nothing above it is noise.
   */
  const items = (() => {
    const pinned = chats.filter((c) => c.pinned);
    const rest = chats.filter((c) => !c.pinned);
    if (!pinned.length) return rest.map((chat) => ({ kind: 'chat' as const, chat }));
    return [
      { kind: 'heading' as const, key: 'h-pinned', label: 'Pinned' },
      ...pinned.map((chat) => ({ kind: 'chat' as const, chat })),
      ...(rest.length
        ? [{ kind: 'heading' as const, key: 'h-recent', label: 'Recent' }]
        : []),
      ...rest.map((chat) => ({ kind: 'chat' as const, chat })),
    ];
  })();

  /**
   * Load the next page when the end of the list comes into view.
   *
   * An IntersectionObserver rather than a scroll handler: it fires once when
   * the sentinel appears instead of on every pixel, and it works whichever
   * element is actually doing the scrolling. rootMargin starts the fetch a
   * little early so the next page is usually there before the user reaches it.
   */
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) onLoadMore(); },
      { rootMargin: '160px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onLoadMore, chats.length]);

  return (
    <nav className="chatlist" aria-label="Saved chats">
      <div className="chatlist-head">
        <span>Chats</span>
        <button
          type="button"
          className="newchat"
          onClick={onNew}
          disabled={busy}
          title="Start a new chat"
        >
          <IconPlus />
          New
        </button>
      </div>

      {chats.length === 0 ? (
        <p className="chatlist-empty">
          No saved chats yet. Ask something and it will be kept here.
        </p>
      ) : (
        <ul className="chatlist-items">
          {items.map((entry) =>
            entry.kind === 'heading' ? (
              /* A heading rather than two lists: the pinned rows sit in the
                 same scroll container as the rest, so the sentinel at the
                 bottom still governs paging and nothing has to know that the
                 top of the list came from a different query. */
              <li key={entry.key} className="chatlist-section" aria-hidden="true">
                {entry.label}
              </li>
            ) : (
              <li
                key={entry.chat.id}
                className={`chatitem${entry.chat.id === activeId ? ' active' : ''}${
                  entry.chat.pinned ? ' pinned' : ''
                }`}
              >
                <button
                  type="button"
                  className="chatitem-open"
                  onClick={() => onOpen(entry.chat.id)}
                  disabled={busy}
                  title={entry.chat.title}
                  aria-current={entry.chat.id === activeId || undefined}
                >
                  <span className="chatitem-title">{entry.chat.title}</span>
                  <span className="chatitem-meta">
                    {/* Rendered from the count, not from a character inside the
                        title: the paperclip belongs to the thread's state, and
                        a title is text the user is free to rewrite. */}
                    {!!entry.chat.attachments && (
                      <span
                        className="chatitem-clip"
                        title={`${entry.chat.attachments} file${entry.chat.attachments === 1 ? '' : 's'} attached`}
                      >
                        <IconFile />
                        {entry.chat.attachments > 1 && entry.chat.attachments}
                      </span>
                    )}
                    {entry.chat.turns} {entry.chat.turns === 1 ? 'msg' : 'msgs'} ·{' '}
                    {ago(entry.chat.updatedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  className={`chatitem-pin${entry.chat.pinned ? ' on' : ''}`}
                  onClick={() => onTogglePin(entry.chat.id, !entry.chat.pinned)}
                  disabled={busy}
                  aria-pressed={Boolean(entry.chat.pinned)}
                  aria-label={`${entry.chat.pinned ? 'Unpin' : 'Pin'} chat: ${entry.chat.title}`}
                  title={entry.chat.pinned ? 'Unpin this chat' : 'Pin this chat'}
                >
                  <IconPin filled={Boolean(entry.chat.pinned)} />
                </button>
                <button
                  type="button"
                  className="chatitem-del"
                  onClick={() => onDelete(entry.chat.id)}
                  disabled={busy}
                  aria-label={`Delete chat: ${entry.chat.title}`}
                  title="Delete this chat"
                >
                  <IconTrash />
                </button>
              </li>
            ),
          )}
        </ul>
      )}

      {/* The trigger for the next page. Rendered only while there is one, so
          the observer has nothing to watch once the list is exhausted. */}
      {hasMore && (
        <div className="chatlist-more" ref={sentinel} aria-hidden="true">
          {loadingMore ? <span className="chatlist-spinner" /> : null}
        </div>
      )}
    </nav>
  );
}

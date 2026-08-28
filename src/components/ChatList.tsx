import { useEffect, useRef } from 'react';
import type { Conversation } from '../types';
import { IconPlus, IconTrash } from './icons';

interface Props {
  chats: Conversation[];
  activeId: string | null;
  busy: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
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
  chats, activeId, busy, onNew, onOpen, onDelete, onLoadMore, hasMore, loadingMore,
}: Props) {
  const sentinel = useRef<HTMLDivElement>(null);

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
          {chats.map((c) => (
            <li key={c.id} className={`chatitem${c.id === activeId ? ' active' : ''}`}>
              <button
                type="button"
                className="chatitem-open"
                onClick={() => onOpen(c.id)}
                disabled={busy}
                title={c.title}
                aria-current={c.id === activeId || undefined}
              >
                <span className="chatitem-title">{c.title}</span>
                <span className="chatitem-meta">
                  {c.turns} {c.turns === 1 ? 'msg' : 'msgs'} · {ago(c.updatedAt)}
                </span>
              </button>
              <button
                type="button"
                className="chatitem-del"
                onClick={() => onDelete(c.id)}
                disabled={busy}
                aria-label={`Delete chat: ${c.title}`}
                title="Delete this chat"
              >
                <IconTrash />
              </button>
            </li>
          ))}
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

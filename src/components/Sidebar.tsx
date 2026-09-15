import { useState } from 'react';
import { BRAND } from '../brand';
import { DEFAULT_BRAND } from '../brand-schema';
import type { Mode } from '../theme';
import type { Conversation } from '../types';
import { ChatList } from './ChatList';

interface SidebarProps {
  chats: Conversation[];
  activeChatId: string | null;
  busy: boolean;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  /** Fetch the next page. Called when the end of the list scrolls into view. */
  onLoadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  /** Which theme is showing, for a brand with a separate dark-theme logo. */
  mode: Mode;
}

export function Sidebar({
  chats, activeChatId, busy, onNewChat, onOpenChat, onDeleteChat, onTogglePin,
  onLoadMore, hasMore, loadingMore, mode,
}: SidebarProps) {
  /* A logo URL that fails to load must not leave a broken-image icon where the
     brand should be; it falls back to the name, like a brand with no logo. */
  const [broken, setBroken] = useState<string | null>(null);
  const wanted = mode === 'dark' && BRAND.logoDark ? BRAND.logoDark : BRAND.logo;
  const logo = wanted !== null && wanted !== broken ? wanted : null;
  const isDefault = logo === DEFAULT_BRAND.logo;

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        {logo ? (
          <span className={isDefault ? 'brand-plate' : 'brand-plate is-custom'}>
            <img
              src={logo}
              alt={BRAND.company}
              /* A customer's logo may live on their own CDN; it has no business
                 learning which page of this app each user is on. */
              referrerPolicy="no-referrer"
              onError={() => setBroken(logo)}
              /* Only the shipped wordmark's shape is known in advance. */
              {...(isDefault ? { width: 260, height: 124 } : {})}
            />
          </span>
        ) : (
          <span className="brand-wordmark">{BRAND.name}</span>
        )}
        <div className="brand-sub">
          {/* With a wordmark the name is already the heading above. */}
          {logo ? <><strong>{BRAND.name}</strong> · {BRAND.tagline}</> : BRAND.tagline}
        </div>
      </div>

      <ChatList
        chats={chats}
        activeId={activeChatId}
        busy={busy}
        onNew={onNewChat}
        onOpen={onOpenChat}
        onDelete={onDeleteChat}
        onTogglePin={onTogglePin}
        onLoadMore={onLoadMore}
        hasMore={hasMore}
        loadingMore={loadingMore}
      />

      <div className="sidebar-foot">
        <div className="foot-line">Read-only agent</div>
        <div className="foot-sub">Every query is logged and shown</div>
      </div>
    </aside>
  );
}

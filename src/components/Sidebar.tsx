import type { Conversation } from '../types';
import { ChatList } from './ChatList';

interface SidebarProps {
  chats: Conversation[];
  activeChatId: string | null;
  busy: boolean;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  /** Fetch the next page. Called when the end of the list scrolls into view. */
  onLoadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
}

export function Sidebar({
  chats, activeChatId, busy, onNewChat, onOpenChat, onDeleteChat,
  onLoadMore, hasMore, loadingMore,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-plate">
          <img src="/rafai-logo.png" alt="Rafai Technologies" width={260} height={124} />
        </span>
        <div className="brand-sub">
          <strong>Rafai AI</strong> · Analytics
        </div>
      </div>

      <ChatList
        chats={chats}
        activeId={activeChatId}
        busy={busy}
        onNew={onNewChat}
        onOpen={onOpenChat}
        onDelete={onDeleteChat}
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

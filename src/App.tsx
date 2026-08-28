import { useCallback, useEffect, useRef, useState } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';
import {
  ask, conversationTurns, conversations, deleteAttachment, deleteConversation, listAttachments,
  listRoles, schema, switchRole, uploadAttachment,
} from './api';
import { useTheme } from './theme';
import type { Attachment, Conversation, HistoryTurn, RoleInfo, Turn } from './types';
import { ChatPanel } from './components/ChatPanel';
import { FeaturesPanel } from './components/FeaturesPanel';
import { Composer } from './components/Composer';
import { IconPanel } from './components/icons';
import { Sidebar } from './components/Sidebar';

/**
 * Starter questions now come from the API, keyed by the role's profile, so the
 * frontend does not carry its own copy of a per-customer role list. Each set
 * deliberately includes one question the role is meant to be REFUSED — a demo
 * that only shows successes says nothing about whether the access rules work.
 */
const FALLBACK_QUESTIONS = [
  'How many consignments did we book last month?',
  'Which vehicles have expired documents right now?',
  'How many consignments are still in transit?',
];

/** A stored turn rendered exactly as it first appeared, chart and SQL included. */
const toTurn = (role: string) => (h: HistoryTurn): Turn => ({
  id: `h-${h.id}`,
  question: h.question,
  role,
  pending: false,
  result: { answer: h.answer, trace: h.trace, hops: h.hops, usage: { input: 0, output: 0, cacheRead: 0 } },
});

export default function App() {
  const { mode, toggle } = useTheme();
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [active, setActive] = useState<string>('OPERATION_EXECUTIVE');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [chats, setChats] = useState<Conversation[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  /* One page of threads at a time, plus the cursor for the next. */
  const [chatCursor, setChatCursor] = useState<string | null>(null);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  /**
   * Open on a desktop, closed on a phone. On mobile the sidebar is a
   * slide-over drawer covering most of the screen, so defaulting it open
   * would greet every phone user with the chat list instead of the chat.
   * Read once at mount rather than tracked on resize — someone rotating a
   * phone should not have the drawer appear or vanish under them.
   */
  const [railOpen, setRailOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth > 860,
  );
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* ------------------------------------------------------------------ routing
     The URL is the source of truth for what is on screen, so a refresh, a
     bookmark and the back button all land where the user expects. Deriving
     from the path rather than mirroring it into state means the two can never
     disagree.

       /              a new chat
       /c/:id         a saved thread
       /features      the dashboard list
       /features/:id  one dashboard
  */
  const location = useLocation();
  const navigate = useNavigate();
  const featuresRoute = matchPath('/features/*', location.pathname)
    ?? matchPath('/features', location.pathname);
  const tab: 'chat' | 'features' = featuresRoute ? 'features' : 'chat';
  const routeChatId = matchPath('/c/:id', location.pathname)?.params.id ?? null;
  const routeDashboardId = matchPath('/features/:id', location.pathname)?.params.id ?? null;

  const applyRole = useCallback(async (role: string) => {
    setBusy(true);
    try {
      await switchRole(role);
      setActive(role);
      await schema(); // verifies the role switch landed; result is not displayed
      setFatal(null);

      // Switching role swaps the whole thread list with it — a manager must
      // not find the accounts conversations waiting for them, because those
      // answers hold figures this role cannot see.
      const page = await conversations();
      setChats(page.items);
      setChatCursor(page.nextCursor);

      // Switching role clears the open thread — it belonged to the other role's
      // list. A REFRESH is different and must not land here: the URL says which
      // thread was open and the route effect below reopens it.
      setTurns([]);
      setAttachments([]);
      setAttachError(null);
    } catch (e: any) {
      setFatal(e.message ?? 'Could not reach the agent service.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const list = await listRoles();
        setRoles(list);
        await applyRole(list[0]?.role ?? 'OPERATION_EXECUTIVE');
      } catch (e: any) {
        setFatal(`${e.message ?? e}. Is the agent service running on :3000?`);
      }
    })();
  }, [applyRole]);

  /**
   * Reload the first page after something changed the list.
   *
   * Resets the cursor with it. Keeping an old cursor after the list has
   * reordered would page into the middle of a list that no longer exists.
   */
  const reloadChats = useCallback(async () => {
    const page = await conversations();
    setChats(page.items);
    setChatCursor(page.nextCursor);
  }, []);

  /**
   * The URL opened a thread — load it.
   *
   * This is what makes a refresh land where the user left off, and it is the
   * ONLY place a thread gets loaded. A click navigates; this reacts. Two paths
   * into the same state is how a click and a reload end up behaving
   * differently.
   */
  useEffect(() => {
    if (!roles.length) return;               // wait for the role to settle
    if (routeChatId && routeChatId !== chatId) { void openChat(routeChatId); return; }
    if (!routeChatId && chatId) { setChatId(null); setTurns([]); setAttachments([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeChatId, roles.length]);

  /** Next page of threads, for the sidebar's infinite scroll. */
  const loadMoreChats = useCallback(async () => {
    if (!chatCursor || chatsLoading) return;
    setChatsLoading(true);
    try {
      const page = await conversations({ cursor: chatCursor });
      /* Append by id rather than blindly concatenating: a thread bumped to the
         top while the user was scrolling would otherwise appear twice. */
      setChats((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...page.items.filter((c) => !seen.has(c.id))];
      });
      setChatCursor(page.nextCursor);
    } catch {
      /* A failed page is not worth an error banner over the whole app; the
         sentinel stays put and the next scroll retries. */
    } finally {
      setChatsLoading(false);
    }
  }, [chatCursor, chatsLoading]);

  const submit = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || busy) return;

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      /* The files ride along with the message they were sent with, and the
         composer is cleared. They stay attached to the CONVERSATION server-side
         and keep reaching the model on later turns — which is why every answer
         still prints "In context for this answer". Clearing the composer tidies
         the input without hiding that fact. */
      const sent = attachments;
      setTurns((t) => [
        ...t,
        { id, question: q, role: active, pending: true, sentAttachments: sent.length ? sent : undefined },
      ]);
      setDraft('');
      setAttachments([]);
      setAttachError(null);
      setBusy(true);

      try {
        const result = await ask(q, chatId);
        setTurns((t) =>
          t.map((turn) => (turn.id === id ? { ...turn, result, pending: false } : turn)),
        );

        // A first message creates the thread server-side; adopt its id so the
        // next question in this chat joins the same one.
        if (result.conversation_id && result.conversation_id !== chatId) {
          setChatId(result.conversation_id);
          /* replace, not push: the empty composer at "/" is not a place the
             back button should return to mid-conversation. */
          navigate(`/c/${result.conversation_id}`, { replace: true });
        }
        await reloadChats();
      } catch (e: any) {
        setTurns((t) =>
          t.map((turn) =>
            turn.id === id
              ? { ...turn, error: e.message ?? 'The request failed.', pending: false }
              : turn,
          ),
        );
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [active, busy, chatId, attachments],
  );

  /**
   * Detaching a file removes it from the conversation server-side, so it stops
   * being fed to the model on every later turn. The chip is only removed from
   * the UI once the server confirms — showing it gone while it is still in
   * context would be exactly the kind of quiet lie this product avoids.
   */
  const removeAttachment = useCallback(
    async (attachmentId: string) => {
      if (!chatId) { setAttachments((prev) => prev.filter((a) => a.id !== attachmentId)); return; }
      setAttachError(null);
      try {
        await deleteAttachment(chatId, attachmentId);
        setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
      } catch (e: any) {
        setAttachError(e.message ?? 'Could not remove that file.');
      }
    },
    [chatId, navigate, reloadChats],
  );

  /** A new chat is simply no thread yet — the first question creates one. */
  const newChat = useCallback(() => {
    navigate('/');
    setChatId(null);
    setTurns([]);
    setAttachments([]);
    setAttachError(null);
    inputRef.current?.focus();
  }, [navigate]);

  /**
   * Loads a thread. Called by the route effect below, not by the click —
   * clicking navigates, and the URL change is what opens it. One path in means
   * a click and a refresh behave identically.
   */
  const openChat = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        setChatId(id);
        const [turnList, attachmentList] = await Promise.all([
          conversationTurns(id),
          listAttachments(id),
        ]);
        setTurns(turnList.map(toTurn(active)));
        setAttachments(attachmentList);
        setAttachError(null);
      } catch (e: any) {
        setFatal(e.message ?? 'Could not open that chat.');
      } finally {
        setBusy(false);
      }
    },
    [active],
  );

  /**
   * Uploads immediately on selection rather than staging until Send — matches
   * how the backend already works (an upload lazily creates a conversation
   * exactly like the first question does), and means the composer never
   * silently discards a file if a follow-up question is never asked.
   */
  const handleAttach = useCallback(
    async (files: FileList) => {
      const list = Array.from(files);
      if (!list.length) return;
      setAttachBusy(true);
      setAttachError(null);

      // Tracked locally (not read from chatId) because a new conversation
      // created by the first file in this batch must receive the rest of the
      // batch too, and setChatId's update would not be visible mid-loop.
      let effectiveId = chatId;
      let failed = false;
      for (const file of list) {
        try {
          const res = await uploadAttachment(file, effectiveId);
          effectiveId = res.conversation_id;
          setAttachments((prev) => [...prev, res.attachment]);
        } catch (e: any) {
          setAttachError(e.message ?? 'The file could not be attached.');
          failed = true;
          break;
        }
      }
      if (effectiveId !== chatId) setChatId(effectiveId);
      setAttachBusy(false);
      if (!failed) await reloadChats();
    },
    [chatId, navigate, reloadChats],
  );

  const removeChat = useCallback(
    async (id: string) => {
      await deleteConversation(id);
      await reloadChats();
      // Only disturb the open thread if it is the one that just went.
      if (id === chatId) {
        setChatId(null);
        setTurns([]);
        navigate('/');
      }
    },
    [chatId, navigate, reloadChats],
  );


  return (
    <div className={`shell${railOpen ? "" : " rail-closed"}`}>
      {/* Mobile only (removed by CSS above 860px): tapping beside the drawer
          closes it, which is the gesture people expect from a slide-over.
          Deliberately hidden from assistive tech and out of the tab order —
          it is a pointer convenience that duplicates the labelled toggle in
          the topbar, and an unnamed button in the a11y tree is worse than no
          button at all. */}
      <div
        className="rail-scrim"
        aria-hidden="true"
        onClick={() => setRailOpen(false)}
      />
      <Sidebar
        chats={chats}
        activeChatId={chatId}
        busy={busy}
        /* On a phone the drawer covers the conversation, so picking a chat or
           starting a new one has to dismiss it — otherwise the user taps and
           appears to land nowhere. */
        onNewChat={() => { newChat(); if (window.innerWidth <= 860) setRailOpen(false); }}
        onOpenChat={(id) => { navigate(`/c/${id}`); if (window.innerWidth <= 860) setRailOpen(false); }}
        onLoadMore={loadMoreChats}
        hasMore={Boolean(chatCursor)}
        loadingMore={chatsLoading}
        onDeleteChat={removeChat}
      />

      <div className="workspace">
        <header className="topbar">
          <button
            className="rail-toggle"
            onClick={() => setRailOpen((o) => !o)}
            aria-label={railOpen ? 'Hide sidebar' : 'Show sidebar'}
            aria-expanded={railOpen}
            title={railOpen ? 'Hide sidebar' : 'Show sidebar'}
          >
            <IconPanel />
          </button>
          <div className="topbar-title">
            <h1>Rafai AI</h1>
            <p>
              Ask in plain English. Answers come only from the views this
              login is granted, and every query is shown.
            </p>
          </div>

          <div className="topbar-controls">
            <div className="rolepick">
              <label htmlFor="role">Signed in as</label>
              <select
                id="role"
                value={active}
                disabled={busy}
                onChange={(e) => applyRole(e.target.value)}
              >
                {roles.map((r) => (
                  <option key={r.role} value={r.role}>{r.label}</option>
                ))}
              </select>
            </div>
            <button className="ghost" onClick={toggle} aria-label="Toggle colour theme">
              {mode === 'dark' ? 'Light' : 'Dark'}
            </button>
          </div>
        </header>

        {fatal && <div className="fatal" role="alert">{fatal}</div>}

        <div className="tabs" role="tablist" aria-label="Workspace">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'chat'}
            className={tab === 'chat' ? 'tab is-on' : 'tab'}
            onClick={() => navigate(chatId ? `/c/${chatId}` : '/')}
          >
            Chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'features'}
            className={tab === 'features' ? 'tab is-on' : 'tab'}
            onClick={() => navigate('/features')}
          >
            Features
          </button>
        </div>

        <div className="scroll">

          {tab === 'features' ? (
            <FeaturesPanel
              mode={mode}
              role={active}
              openId={routeDashboardId}
              onOpen={(id) => navigate(`/features/${id}`)}
              onBack={() => navigate('/features')}
            />
          ) : turns.length === 0 ? (
            /* Nothing asked yet: the input is the page, not a strip pinned to
               the bottom edge. It docks down once a conversation starts. */
            <div className="hero">
              <h2 className="hero-title">Ask Rafai AI about your operations.</h2>
              <p className="hero-sub">
                Answers come only from the views this role is allowed to read.
                Every query is shown, and anything outside the role's access is
                refused rather than answered.
              </p>

              <Composer
                ref={inputRef}
                value={draft}
                busy={busy}
                onChange={setDraft}
                onSubmit={() => submit(draft)}
                attachments={attachments}
                attachBusy={attachBusy}
                attachError={attachError}
                onAttach={handleAttach}
                onRemoveAttachment={removeAttachment}
              />

              <div className="suggestions">
                {(roles.find((r) => r.role === active)?.questions ?? FALLBACK_QUESTIONS).map((q) => (
                  <button key={q} className="suggestion" onClick={() => submit(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <ChatPanel
              turns={turns}
              mode={mode}
              conversationId={chatId}
              onFeatureCreated={(id) => navigate(`/features/${id}`)}
            />
          )}
        </div>

        {tab === 'chat' && turns.length > 0 && (
          <div className="dock">
            <Composer
              ref={inputRef}
              value={draft}
              busy={busy}
              placeholder="Ask a follow-up…"
              onChange={setDraft}
              onSubmit={() => submit(draft)}
              attachments={attachments}
              attachBusy={attachBusy}
              attachError={attachError}
              onAttach={handleAttach}
              onRemoveAttachment={removeAttachment}
            />
          </div>
        )}
      </div>
    </div>
  );
}

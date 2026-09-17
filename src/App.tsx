import { useCallback, useEffect, useRef, useState } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';
import {
  askStream, ConnectionLostError, conversationTurns, conversations, deleteAttachment, deleteConversation,
  listAttachments, recoverAskResult, setPinned,
  listRoles, schema, switchRole, uploadAttachment,
} from './api';
import { BRAND } from './brand';
import { useTheme } from './theme';
import type { Attachment, Conversation, HistoryTurn, RoleInfo, Turn } from './types';
import { ChatPanel } from './components/ChatPanel';
import { FeaturesPanel } from './components/FeaturesPanel';
import { Composer } from './components/Composer';
import { IconPanel } from './components/icons';
import { Sidebar } from './components/Sidebar';

/** The role a session opens in when nothing else has been chosen. */
const DEFAULT_ROLE = 'ADMIN';

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
  /* The server's id, kept alongside the local render key: editing and
     re-running address the STORED turn, which `h-123` is not. */
  turnId: String(h.id),
  question: h.question,
  role,
  pending: false,
  result: { answer: h.answer, trace: h.trace, hops: h.hops, usage: { input: 0, output: 0, cacheRead: 0 } },
});

export default function App() {
  const { mode, toggle } = useTheme();
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [active, setActive] = useState<string>(DEFAULT_ROLE);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [chats, setChats] = useState<Conversation[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  /* One page of threads at a time, plus the cursor for the next. */
  const [chatCursor, setChatCursor] = useState<string | null>(null);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  /** Recoverable, dismissible message. Unlike `fatal`, the app stays usable. */
  const [notice, setNotice] = useState<string | null>(null);
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

  /**
   * The current path, readable from a stable callback.
   *
   * applyRole needs to know whether a thread is open, but closing over
   * location.pathname would change its identity on every navigation -- and the
   * mount effect below depends on applyRole, so it would re-run listRoles and
   * re-mint a token every time the URL changed.
   */
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  /* navigate is not referentially stable across location changes either, and it
     lands in the same dependency chain -- measured: two navigations produced two
     extra /auth/roles calls, i.e. the whole mount effect re-running. */
  const navRef = useRef(navigate);
  navRef.current = navigate;
  /* Same assign-on-render pattern: the send handler needs the turn ids that
     existed BEFORE it ran, and adding `turns` to its dependency list would
     rebuild the callback every time an answer landed. */
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  const applyRole = useCallback(async (role: string, initial = false) => {
    setBusy(true);
    try {
      await switchRole(role);
      setActive(role);
      setFatal(null);

      // Switching role swaps the whole thread list with it — a manager must
      // not find the accounts conversations waiting for them, because those
      // answers hold figures this role cannot see.
      const page = await conversations();
      setChats(page.items);
      setChatCursor(page.nextCursor);

      /**
       * The schema probe runs AFTER the composer is free, and is not awaited.
       *
       * It was awaited here, between the token and the chat list, purely to
       * confirm the role switch had landed -- and its own comment said the
       * result was never displayed. Measured on webtrans_CTS_AI it takes 13.9
       * seconds on the first call of a session, because that call is what
       * builds the catalogue. So the composer sat disabled for fourteen seconds
       * waiting on an answer nobody reads, which is the whole of "why does the
       * chat take so long to become usable".
       *
       * Firing it without awaiting keeps both things it was worth having: the
       * catalogue is warm by the time the first question is asked, and a role
       * switch that genuinely failed still surfaces -- just after the user can
       * type rather than before. Warm, it returns in 3 ms, so this costs
       * nothing on every later switch.
       */
      void schema().catch((e: any) =>
        setFatal(e?.message ?? 'Could not load the schema for this role.'),
      );

      /**
       * Switching role clears the open thread — it belonged to the other role's
       * list, and its answers can hold figures this role cannot see.
       *
       * A first load must NOT clear anything, which is why `initial` exists.
       * The route effect below is gated on roles.length, so publishing the role
       * list is what lets a refresh reopen the thread named in the URL. When
       * mount published that list BEFORE awaiting applyRole, the two ran
       * concurrently: openChat loaded /c/:id while applyRole was still working,
       * and then applyRole finished and wiped it. Whichever settled last won,
       * so the thread appeared or did not appear at random — the sidebar row
       * highlighted, the pane empty.
       *
       * Mount now publishes the roles only after this resolves, and skips the
       * clear entirely.
       */
      if (!initial) {
        setTurns([]);
        setAttachments([]);
        setAttachError(null);
        /* The URL named a thread belonging to the role we just left. Leaving it
           in the address bar would show an empty pane under a live /c/:id, and
           a refresh would then ask for a thread this role cannot open. */
        if (matchPath('/c/:id', pathRef.current)) navRef.current('/', { replace: true });
      }
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
        /* Role first, list second. setRoles opens the route effect's gate, and
           opening it before applyRole has settled is what let the two race. */
        /* Chosen BY NAME, not by position. This was list[0], so the default
           was whatever happened to sit first in roles.json — reordering that
           file silently changed which role every new session started in. */
        const preferred = list.find((r) => r.role === DEFAULT_ROLE)?.role;
        await applyRole(preferred ?? list[0]?.role ?? DEFAULT_ROLE, true);
        setRoles(list);
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

  /**
   * Pin or unpin, optimistically.
   *
   * The row is moved in local state before the request resolves, because the
   * whole point of the control is that the list reorders under your cursor. On
   * failure the previous list is restored — a pin that silently did not stick
   * is worse than one that visibly bounced back.
   */
  const togglePin = useCallback(async (id: string, pinned: boolean) => {
    const before = chats;
    setChats((prev) => {
      const next = prev.map((c) => (c.id === id ? { ...c, pinned } : c));
      const rank = (c: typeof next[number]) => (c.pinned ? 0 : 1);
      return [...next].sort(
        (a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt),
      );
    });
    try {
      await setPinned(id, pinned);
    } catch {
      setChats(before);
    }
  }, [chats]);

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

  /**
   * Send a question.
   *
   * `replace` names a stored turn to overwrite: the edit and re-run controls
   * both pass one, and the server drops that turn and everything after it
   * before answering. The bubbles after it are removed locally at the same
   * moment, so the screen never shows an answer to a question that has just
   * been withdrawn.
   */
  const submit = useCallback(
    async (question: string, replace?: { turnId: string; localId: string }) => {
      const q = question.trim();
      if (!q || busy) return;

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      /* The files ride along with the message they were sent with, and the
         composer is cleared. They stay attached to the CONVERSATION server-side
         and keep reaching the model on later turns — which is why every answer
         still prints "In context for this answer". Clearing the composer tidies
         the input without hiding that fact. */
      const sent = attachments;
      /* Captured before the pending bubble is appended, so recovery can tell a
         turn the server just created from one that was already in the thread. */
      const turnIdsBeforeAsk = turnsRef.current
        .map((x) => x.turnId)
        .filter((x): x is string => !!x);
      setTurns((t) => {
        /* Everything from the replaced turn onward goes now, not when the
           answer lands: leaving it up would show the old exchange and the new
           one side by side, which reads as two questions rather than one
           correction. */
        const kept = replace ? t.slice(0, t.findIndex((x) => x.id === replace.localId)) : t;
        return [
          ...kept,
          { id, question: q, role: active, pending: true, sentAttachments: sent.length ? sent : undefined },
        ];
      });
      setDraft('');
      setAttachments([]);
      setAttachError(null);
      setBusy(true);

      /* Streamed pieces are collected here and painted once per frame. A
         setState per token re-renders the whole thread tens of times a second
         for no visible difference. */
      const live: NonNullable<Turn['live']> = { steps: [], text: '' };
      let frame = 0;
      const paint = () => {
        frame = 0;
        const snapshot = { ...live, steps: [...live.steps] };
        setTurns((t) => t.map((turn) => (turn.id === id && turn.pending ? { ...turn, live: snapshot } : turn)));
      };
      const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };

      try {
        const result = await askStream(q, chatId, replace?.turnId, {
          onStatus: (tool, intent) => { live.tool = tool; live.intent = intent; live.writing = false; schedule(); },
          onText: (delta) => { live.text += delta; live.writing = true; schedule(); },
          /* The text was a step, not the answer — but the user has already read
             it, so it stays on screen until the final answer replaces it. */
          onAck: (text) => { live.ack = text; live.text = ''; live.writing = false; schedule(); },
          onReset: () => {
            if (live.text.trim()) live.steps.push(live.text);
            live.text = '';
            live.writing = false;
            schedule();
          },
        });
        if (frame) cancelAnimationFrame(frame);
        setTurns((t) =>
          t.map((turn) =>
            turn.id === id
              ? { ...turn, result, pending: false, live: undefined, turnId: result.turn_id ?? null }
              : turn,
          ),
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
        if (frame) cancelAnimationFrame(frame);
        /* A dropped connection is not the same as a failed answer. A long
           question can outlive a proxy's read timeout while the service keeps
           working and stores the turn — which is why refreshing the page used
           to reveal the answer the user had just been told did not arrive.
           Look for it rather than reporting a failure that already resolved
           itself. The bubble stays pending throughout: the work really is
           still in flight, and flashing an error we are about to retract is
           worse than a longer wait. */
        if (e instanceof ConnectionLostError) {
          const recovered = await recoverAskResult(
            chatId,
            q,
            turnIdsBeforeAsk,
          ).catch(() => null);

          if (recovered) {
            setTurns((t) =>
              t.map((turn) =>
                turn.id === id
                  ? { ...turn, result: recovered, pending: false, live: undefined, turnId: recovered.turn_id ?? null }
                  : turn,
              ),
            );
            if (recovered.conversation_id && recovered.conversation_id !== chatId) {
              setChatId(recovered.conversation_id);
              navigate(`/c/${recovered.conversation_id}`, { replace: true });
            }
            await reloadChats();
            return;
          }
        }

        setTurns((t) =>
          t.map((turn) =>
            turn.id === id
              ? { ...turn, error: e.message ?? 'The request failed.', pending: false, live: undefined }
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
        const [turnList, attachmentList] = await Promise.all([
          conversationTurns(id),
          listAttachments(id),
        ]);
        /**
         * chatId is set AFTER the load, not before it.
         *
         * Set first, it means "opening"; the effect above guards on
         * `routeChatId !== chatId` and so reads a thread that is still fetching
         * as one already open. If that pass is then discarded -- StrictMode
         * double-invokes effects in development, and a slow network does the
         * same thing in production -- nothing retries, and the thread sits
         * highlighted in the sidebar above an empty pane. Reproduced exactly
         * that way on /c/107.
         *
         * Set last, chatId means "loaded", the guard is honest, and a discarded
         * attempt is simply retried. The cost is that the sidebar highlight
         * lands a moment later, which is the correct trade.
         */
        setChatId(id);
        setTurns(turnList.map(toTurn(active)));
        setAttachments(attachmentList);
        setAttachError(null);
        setNotice(null);
      } catch {
        /**
         * A chat that will not open is a dead end, not a fatal error.
         *
         * The backend answers 404 for any thread this (tenant, user, role)
         * does not own, and in the demo the identity is DERIVED from the role
         * -- `demo.${role}` -- so every role keeps its own history. Open a URL
         * for a thread you started under a different role and it is, correctly,
         * not yours.
         *
         * It used to setFatal() the server's text, which left "No such
         * conversation" on screen over an empty pane with nothing to click.
         * The thread is unreachable; the app is not.
         *
         * The wording is deliberately the same whether the id exists or not.
         * The 404 is what stops one role confirming another role's thread
         * exists, and a message that said "belongs to ADMIN" would hand back
         * exactly what the status code is there to withhold.
         */
        setTurns([]);
        setAttachments([]);
        setChatId(null);
        setNotice(
          'That chat is not available for the current role. Chats are kept ' +
            'separately per role — if you started it under another one, switch ' +
            'roles and open it from the list.',
        );
        navigate('/', { replace: true });
      } finally {
        setBusy(false);
      }
    },
    [active, navigate],
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
        onTogglePin={togglePin}
        onDeleteChat={removeChat}
        mode={mode}
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
            <h1>{BRAND.name}</h1>
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
        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
          </div>
        )}

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
              <h2 className="hero-title">Ask {BRAND.name} about your operations.</h2>
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
              onResubmit={(q, replace) => void submit(q, replace)}
              onAsk={(q) => void submit(q)}
              busy={busy}
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

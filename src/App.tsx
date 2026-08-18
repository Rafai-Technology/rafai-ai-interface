import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ask, conversationTurns, conversations, deleteConversation, listAttachments,
  listRoles, schema, switchRole, uploadAttachment,
} from './api';
import { useTheme } from './theme';
import type { Attachment, Conversation, HistoryTurn, RoleInfo, Turn } from './types';
import { ChatPanel } from './components/ChatPanel';
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
      const threads = await conversations();
      setChats(threads);

      // Always land on an empty composer. Reopening the last thread meant a
      // refresh dropped you mid-conversation with someone else's question on
      // screen — and in a demo the first thing anyone does is reload. Saved
      // threads are still one click away in the sidebar.
      setChatId(null);
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

  const submit = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || busy) return;

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setTurns((t) => [...t, { id, question: q, role: active, pending: true }]);
      setDraft('');
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
        }
        setChats(await conversations());
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
    [active, busy, chatId],
  );

  /** A new chat is simply no thread yet — the first question creates one. */
  const newChat = useCallback(() => {
    setChatId(null);
    setTurns([]);
    setAttachments([]);
    setAttachError(null);
    inputRef.current?.focus();
  }, []);

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
      if (!failed) setChats(await conversations());
    },
    [chatId],
  );

  const removeChat = useCallback(
    async (id: string) => {
      await deleteConversation(id);
      const remaining = await conversations();
      setChats(remaining);
      // Only disturb the open thread if it is the one that just went.
      if (id === chatId) {
        setChatId(null);
        setTurns([]);
      }
    },
    [chatId],
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
        onOpenChat={(id) => { openChat(id); if (window.innerWidth <= 860) setRailOpen(false); }}
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

        <div className="scroll">

          {turns.length === 0 ? (
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
            <ChatPanel turns={turns} mode={mode} />
          )}
        </div>

        {turns.length > 0 && (
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
            />
          </div>
        )}
      </div>
    </div>
  );
}

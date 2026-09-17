import { useEffect, useRef, useState } from 'react';
import type { Mode } from '../theme';
import type { AnswerScope, ScopeCounts, Turn, TraceStep } from '../types';
import { forecastChart, inferChart, parseAnswer, rowsForChart, scopeCounts, type FollowUp } from '../answer';
import { exportAsPdf, exportRowsAsCsv, provenanceFrom } from '../export';
import { formatBytes, splitFilename } from '../format';
import { ChartRenderer } from './ChartRenderer';
import { ExportFileCard } from './ExportFileCard';
import { IconCheck, IconCopy, IconEdit, IconFile, IconRerun } from './icons';
import { Markdown } from './Markdown';
import { InsightsPanel } from './InsightsPanel';
import { SaveDashboardDialog, panelsFromTurn } from './SaveDashboardDialog';
import { SqlInspector } from './SqlInspector';

/** The last query result in the trace, regardless of whether it matched a
 *  chart's axes — the fallback data source for exporting a plain table when
 *  the answer had no chart to attach the request to. */
function lastResultRows(trace: TraceStep[]): Record<string, any>[] | null {
  for (let i = trace.length - 1; i >= 0; i--) {
    const step = trace[i];
    if (step.status === 'ok' && step.rows?.length) return step.rows;
  }
  return null;
}

/** Rendered only when export_result was called but no chart exists to attach
 *  the file card to — e.g. "export the customer list to CSV" with too few or
 *  non-numeric rows to chart. Builds nothing until clicked. */
function TableExportCard({ request, trace, role }: {
  request: NonNullable<TraceStep['exportRequest']>;
  trace: TraceStep[];
  role?: string;
}) {
  if (request.format === 'png') return null; // nothing to rasterize without a chart
  const rows = lastResultRows(trace);
  if (!rows?.length) return null;
  const columns = Object.keys(rows[0]);
  return (
    <ExportFileCard
      format={request.format}
      title={request.title}
      onDownload={() =>
        request.format === 'csv'
          ? exportRowsAsCsv(rows, columns, request.title)
          : exportAsPdf({
              title: request.title,
              rows,
              columns,
              summary: request.summary,
              caveats: request.caveats,
              provenance: provenanceFrom(trace, role),
            })
      }
    />
  );
}

interface Props {
  turns: Turn[];
  mode: Mode;
  /** Which thread these turns belong to, so a saved feature can be traced
   *  back to the conversation that produced it. */
  conversationId?: string | null;
  /** Called after a feature is created, so the shell can navigate to it. */
  onFeatureCreated?: (id: string) => void;
  /** Ask again, replacing a stored turn: the edited text (or the original, for
   *  a straight re-run) plus which exchange it supersedes. */
  onResubmit?: (question: string, replace: { turnId: string; localId: string }) => void;
  /** True while a question is in flight — the controls disable rather than
   *  queueing a second ask on top of one already running. */
  busy?: boolean;
  /** Ask a new question in this chat — used by the follow-up buttons. */
  onAsk?: (question: string) => void;
}

/**
 * The question, editable in place.
 *
 * A textarea rather than an input: these are sentences, and a single-line box
 * that scrolls sideways hides the half of the question somebody is trying to
 * correct. Enter submits and Shift+Enter breaks the line, matching the
 * composer below so the two do not need separate learning.
 */
function QuestionEditor({
  initial, busy, onCancel, onSubmit,
}: {
  initial: string;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (next: string) => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Caret at the end, not selecting everything: the usual edit is a tweak to
    // a long question, and select-all makes the first keystroke destroy it.
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  const unchanged = text.trim() === initial.trim();

  return (
    <div className="question-edit">
      <textarea
        ref={ref}
        value={text}
        rows={1}
        onChange={(e) => {
          setText(e.target.value);
          e.target.style.height = 'auto';
          e.target.style.height = `${e.target.scrollHeight}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (text.trim() && !unchanged) onSubmit(text.trim());
          }
        }}
        aria-label="Edit your question"
      />
      <div className="question-edit-actions">
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="primary"
          disabled={busy || !text.trim() || unchanged}
          onClick={() => onSubmit(text.trim())}
          /* Disabled when nothing changed: re-running an identical question is
             what the re-run control is for, and doing it from here would look
             like the edit silently failed. */
          title={unchanged ? 'Change the question, or use "Ask again"' : 'Ask this instead'}
        >
          Ask again
        </button>
      </div>
    </div>
  );
}

/**
 * A static "Querying…" reads as a hang once a request passes a few seconds.
 * A running clock reads as work in progress, and it tells the truth about how
 * long the model is taking.
 */
/** What each tool is doing, in words a transport operator would use. */
const TOOL_STAGE: Record<string, string> = {
  describe_tables: 'Choosing the right views…',
  run_sql: 'Running the query…',
  run_forecast: 'Building the forecast…',
  detect_anomalies: 'Checking for unusual months…',
  diagnose_process: 'Checking the process…',
  search_business_logic: 'Looking up how Web Trans calculates this…',
  export_result: 'Preparing the file…',
};

/** Shown before the first step starts, one after another, the way Claude
 *  keeps a quiet line moving while it thinks. */
const THINKING_MESSAGES = [
  'Thinking…',
  'Reading your question…',
  'Finding the right data…',
  'Planning the query…',
];

/**
 * The loader that stays above the answer for as long as it is being worked on.
 *
 * It never replaces text: whatever the model has written so far stays below
 * it, so a sentence about the date range does not vanish when the next query
 * starts.
 */
function Working({ tool, intent, writing }: { tool?: string; intent?: string; writing?: boolean }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const stage = writing
    ? 'Writing the answer…'
    : tool
      ? (TOOL_STAGE[tool] ?? 'Working…')
      : THINKING_MESSAGES[Math.floor(secs / 3) % THINKING_MESSAGES.length];

  return (
    <div className="working" role="status">
      <div className="working-line">
        <span className="spinner" aria-hidden />
        {/* Keyed on the message so each new one fades in rather than swapping. */}
        <span className="working-text" key={stage}>{stage}</span>
        <span className="elapsed">{secs}s</span>
      </div>
      {intent && !writing && <div className="working-note">{intent}</div>}
      {secs >= 20 && (
        <div className="working-note">
          Still going — the free-tier model queues under load. A paid key
          answers this in a few seconds.
        </div>
      )}
    </div>
  );
}

/**
 * Text written so far, from every step.
 *
 * The chart spec is a fenced JSON block at the end of the reply; half of one
 * is not something to show, so an unclosed fence is cut off, and a closed
 * chart block is removed the same way the finished answer removes it.
 */
function liveVisible(text: string): string {
  const fences = text.split('```').length - 1;
  const open = fences % 2 === 1 ? text.slice(0, text.lastIndexOf('```')) : text;
  return parseAnswer(open).text;
}

/**
 * Reveals text at a steady pace instead of in the bursts it arrives in.
 *
 * Tokens come a few at a time and then, after a query, in a rush of a
 * hundred characters at once; painted as they land, the text stutters. This
 * shows a few characters per frame, faster the further behind it is, so a
 * burst reads as quick typing and a pause reads as a pause. It is never more
 * than a fraction of a second behind, and catches up at once when the text is
 * reset.
 */
function useSteadyReveal(target: string): string {
  const [shown, setShown] = useState('');
  useEffect(() => {
    if (!target.startsWith(shown)) { setShown(target.length < shown.length ? target : ''); return; }
    if (shown.length >= target.length) return;
    let frame = requestAnimationFrame(() => {
      const behind = target.length - shown.length;
      // ~3 chars/frame when close, most of the backlog when far behind.
      const step = Math.max(3, Math.ceil(behind / 6));
      setShown(target.slice(0, shown.length + step));
    });
    return () => cancelAnimationFrame(frame);
  }, [target, shown]);
  return shown;
}

function Pending({ live }: { live?: Turn['live'] }) {
  const steps = (live?.steps ?? []).map(liveVisible).filter((b) => b.trim());
  const current = liveVisible(useSteadyReveal(live?.text ?? ''));

  /* The acknowledgement ("Theek hai, … thoda time dijiye") is the first thing
     the model says, so it goes first — above the loader, at full weight, for
     the whole wait. Until the server confirms it, text written before any step
     has started is shown in the same place, so it does not jump when the
     confirmation lands. */
  const beforeFirstStep = !live?.ack && !live?.tool && steps.length === 0;
  const top = live?.ack ? liveVisible(live.ack) : beforeFirstStep ? current : '';
  const below = beforeFirstStep ? '' : current;

  return (
    <div className="pending">
      {top.trim() && (
        <div className={`live-ack${live?.ack ? '' : ' live-current'}`} aria-live="polite">
          <Markdown text={top} />
        </div>
      )}
      <Working tool={live?.tool} intent={live?.intent} writing={live?.writing} />
      {(steps.length > 0 || below.trim()) && (
        <div className="live-answer" aria-live="polite">
          {/* What the model wrote beside earlier steps. The service joins it
              into the final answer, so it is shown as answer text. */}
          {steps.map((b, i) => (
            <div className="live-step" key={i}><Markdown text={b} /></div>
          ))}
          {below.trim() && <div className="live-current"><Markdown text={below} /></div>}
        </div>
      )}
    </div>
  );
}

/**
 * The offer to keep this answer as a live dashboard.
 *
 * Shown only when the turn actually ran a query, because a panel with no query
 * has nothing to re-run — and re-running is the entire feature. An answer the
 * model wrote from context alone is not something that can be kept live.
 */
function KeepAsFeature({ turn, conversationId, onCreated }: {
  turn: Turn;
  conversationId?: string | null;
  onCreated?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!turn.result || panelsFromTurn(turn).length === 0) return null;

  return (
    <div className="keep-row">
      {saved ? (
        <span className="keep-done">Saved to Features — it refreshes each time you open it.</span>
      ) : (
        <button type="button" className="keep-btn" onClick={() => setOpen(true)}>
          Create feature
        </button>
      )}
      {open && (
        <SaveDashboardDialog
          turn={turn}
          conversationId={conversationId ?? null}
          onClose={() => setOpen(false)}
          onSaved={(id) => { setOpen(false); setSaved(true); onCreated?.(id); }}
        />
      )}
    </div>
  );
}

/**
 * Suggested next questions, under the answer, the way Perplexity lists
 * "Related". Each one is a whole question: a click asks it as written.
 * Disabled while another answer is in flight rather than queued behind it.
 */
function FollowUps({ items, onAsk, busy }: {
  items: FollowUp[];
  onAsk?: (question: string) => void;
  busy?: boolean;
}) {
  if (!items.length || !onAsk) return null;
  const related = items.filter((f) => !f.insight);
  const insight = items.find((f) => f.insight);
  return (
    <nav className="followups" aria-label="Follow-up questions">
      {related.length > 0 && (
        <>
          <div className="followups-label">Related</div>
          <ul>
            {related.map((f) => (
              <li key={f.text}>
                <button type="button" className="followup" disabled={busy} onClick={() => onAsk(f.text)}>
                  <span className="followup-text">{f.text}</span>
                  <span className="followup-arrow" aria-hidden>→</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {insight && (
        <button
          type="button"
          className="followup-insight"
          disabled={busy}
          onClick={() => onAsk(insight.text)}
        >
          <span className="followup-insight-icon" aria-hidden>✦</span>
          <span className="followup-insight-body">
            <span className="followup-insight-label">Get insights</span>
            <span className="followup-insight-text">{insight.text}</span>
          </span>
          <span className="followup-arrow" aria-hidden>→</span>
        </button>
      )}
    </nav>
  );
}

const count = (n: number) => n.toLocaleString('en-IN');

/** Wider periods offered from the header, as questions the user could type. */
const WIDEN: { label: string; phrase: string }[] = [
  { label: 'Last month', phrase: 'for last month' },
  { label: 'Last 3 months', phrase: 'for the last 3 months' },
  { label: 'This FY', phrase: 'for this financial year' },
  { label: 'All time', phrase: 'for all time' },
];

/**
 * The period a list covers, above the answer, with how much of the data that
 * is — so "412 consignments" is never read as every consignment there is.
 *
 * The counts come from the rows (scopeCounts); a count that is missing is left
 * out rather than guessed. When the list itself stopped at the row cap, that
 * is said too, because the period count is then larger than what is listed.
 */
function ScopeBar({ scope, counts, onAsk, busy }: {
  scope: AnswerScope;
  counts: ScopeCounts | null;
  onAsk?: (question: string) => void;
  busy?: boolean;
}) {
  const noun = scope.noun ?? 'records';
  const inPeriod = counts?.inPeriod;
  const total = counts?.total;
  const cut = inPeriod !== undefined && counts?.returned !== undefined && counts.returned < inPeriod;

  return (
    <div className="scope-bar" role="note">
      <div className="scope-main">
        <span className="scope-period">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          {scope.label}
          {scope.isDefault && <span className="scope-tag">default</span>}
        </span>
        {inPeriod !== undefined && (
          <span className="scope-count">
            <strong>{count(inPeriod)}</strong> {noun}
            {total !== undefined && <> of <strong>{count(total)}</strong> in total</>}
          </span>
        )}
        {cut && <span className="scope-cut">showing the latest {count(counts!.returned!)}</span>}
      </div>
      {onAsk && (
        <div className="scope-widen" aria-label="Change the period">
          {WIDEN.map((w) => (
            <button
              key={w.label}
              type="button"
              className="scope-chip"
              disabled={busy}
              onClick={() => onAsk(`Show the same ${noun} ${w.phrase}`)}
            >
              {w.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Answer({ turn, mode, onAsk, busy }: {
  turn: Turn;
  mode: Mode;
  onAsk?: (question: string) => void;
  busy?: boolean;
}) {
  if (turn.pending) {
    return <Pending live={turn.live} />;
  }
  if (turn.error) {
    return <div className="error">{turn.error}</div>;
  }
  if (!turn.result) return null;

  const { text, chart: given, followups, scope } = parseAnswer(turn.result.answer);
  const counts = scope ? scopeCounts(turn.result.trace) : null;
  const chart =
    forecastChart(turn.result.trace) ?? given ?? inferChart(turn.result.trace);
  const rows = chart ? rowsForChart(turn.result.trace, chart) : null;

  // A card the user clicks to build and save the file — nothing downloads on
  // its own, so this is safe to show again every time a saved chat with a
  // past export_result call is reopened, not just the turn that just ran.
  const exportStep = turn.result.trace.find(
    (s) => s.tool === 'export_result' && s.status === 'ok' && s.exportRequest,
  );
  const exportRequest = exportStep?.exportRequest ?? null;

  /* Read off the trace, not out of the prose: these are the numbers somebody
     makes a decision on, and a figure the model retyped is a figure that can be
     retyped wrong. */
  const findings = turn.result.trace.find(
    (s) => s.tool === 'diagnose_process' && s.status === 'ok' && s.findings?.length,
  )?.findings;

  return (
    <>
      {scope && <ScopeBar scope={scope} counts={counts} onAsk={onAsk} busy={busy} />}
      <Markdown text={text} />
      {findings && findings.length > 0 && <InsightsPanel findings={findings} />}
      {chart && rows ? (
        <ChartRenderer
          spec={chart}
          rows={rows}
          mode={mode}
          exportRequest={exportRequest}
          trace={turn.result.trace}
          role={turn.role}
        />
      ) : (
        exportRequest && (
          <TableExportCard request={exportRequest} trace={turn.result.trace} role={turn.role} />
        )
      )}
      {turn.result.attachments && turn.result.attachments.length > 0 && (
        <div className="attachments-used">
          <span className="attachments-used-label">In context for this answer:</span>
          {turn.result.attachments.map((a) => (
            <span
              key={a.filename}
              className="attachment-chip"
              title={a.truncated ? 'Shown up to the context limit for this turn' : a.filename}
            >
              {/* Bare text in a flex container cannot ellipsise, and this chip
                  has a max-width but no overflow rule — so a long name spilled
                  straight out of it. Same split as the sent chip: the stem
                  truncates, the extension survives. */}
              {/* One wrapper, because the chip is a flex row with a gap — as
                  two separate items the gap opened between the ellipsis and
                  the extension and rendered as "weekly-booking… .xlsx". */}
              <span className="attachment-chip-file">
                <span className="attachment-chip-name">{splitFilename(a.filename).stem}</span>
                <span className="attachment-chip-ext">{splitFilename(a.filename).ext}</span>
              </span>
              {a.truncated && <span className="attachment-chip-flag">truncated</span>}
            </span>
          ))}
        </div>
      )}
      <SqlInspector trace={turn.result.trace} hops={turn.result.hops} />
      <FollowUps items={followups} onAsk={onAsk} busy={busy} />
    </>
  );
}

export function ChatPanel({
  turns, mode, conversationId, onFeatureCreated, onResubmit, busy, onAsk,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  /** Which question was just copied, so the button can confirm it briefly. */
  const [copied, setCopied] = useState<string | null>(null);

  const copyQuestion = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1400);
    } catch {
      /* Clipboard access can be refused (an insecure origin, a permissions
         policy). Silently leaving the icon unchanged is the honest signal:
         nothing was copied, so nothing should say it was. */
    }
  };
  const endRef = useRef<HTMLDivElement>(null);

  /* Follow the answer as it streams, but only while the reader is already at
     the bottom. Someone who has scrolled up to re-read the question is not
     dragged back down on every frame of new text. Instant while streaming
     (a smooth scroll per frame never finishes), smooth otherwise. */
  useEffect(() => {
    const end = endRef.current;
    const pane = end?.closest('.scroll') as HTMLElement | null;
    if (!end) return;
    const streaming = turns.some((t) => t.pending);
    if (pane) {
      const fromBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
      if (streaming && fromBottom > 160) return;
    }
    end.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth', block: 'end' });
  }, [turns]);

  return (
    <div className="chat">
      {turns.map((turn) => (
        <article className="turn" key={turn.id} aria-busy={turn.pending}>
          <div className="question">
            <span className="who">{turn.role.replace(/_/g, ' ').toLowerCase()}</span>
            {editing === turn.id ? (
              <QuestionEditor
                initial={turn.question}
                busy={busy}
                onCancel={() => setEditing(null)}
                onSubmit={(next) => {
                  setEditing(null);
                  onResubmit?.(next, { turnId: turn.turnId!, localId: turn.id });
                }}
              />
            ) : (
              <>
                {turn.question}
              </>
            )}
            {/* What was attached when this was sent. The composer is cleared
                on send, so without this the record of which files went with
                which question would be lost. */}
            {turn.sentAttachments?.length ? (
              <span className="question-files">
                {turn.sentAttachments.map((a) => {
                  const { stem, ext } = splitFilename(a.filename);
                  /* Everything the chip knows, in the order it is scanned:
                     what the file is, how much of it there is, and whether the
                     agent saw all of it. Held back before, so a 5 MB file and a
                     200-byte one looked identical. */
                  const meta = [
                    a.kind.toUpperCase(),
                    a.rows != null ? `${a.rows.toLocaleString()} rows` : null,
                    formatBytes(a.bytes),
                  ].filter(Boolean);
                  return (
                    <span key={a.id} className="question-file" title={a.filename}>
                      <IconFile />
                      <span className="question-file-text">
                        <span className="question-file-name">
                          {/* Two elements, not one string: the stem shrinks and
                              takes the ellipsis, the extension never does. */}
                          <span className="question-file-stem">{stem}</span>
                          {ext && <span className="question-file-ext">{ext}</span>}
                        </span>
                        <span className="question-file-meta">
                          {meta.join(' · ')}
                          {a.truncated && (
                            <span className="question-file-trunc">
                              read to limit
                            </span>
                          )}
                        </span>
                      </span>
                    </span>
                  );
                })}
              </span>
            ) : null}
          </div>

          {/* Below the bubble, not inside it. Overlaid at the top-right they
              crowded the role label and sat on top of the first line of a
              short question; underneath, they have their own row and the
              bubble keeps its shape. */}
          {editing !== turn.id && !turn.pending && (
            <div className="question-tools">
              <button
                type="button"
                className={copied === turn.id ? 'done' : undefined}
                onClick={() => copyQuestion(turn.id, turn.question)}
                aria-label="Copy this question"
                title={copied === turn.id ? 'Copied' : 'Copy'}
              >
                {copied === turn.id ? <IconCheck /> : <IconCopy />}
              </button>
              {/* Edit and re-run need a STORED turn to replace; a turn whose
                  history write failed has no id, so they are not offered. */}
              {turn.turnId && onResubmit && (
                <>
                  <button
                    type="button"
                    onClick={() => setEditing(turn.id)}
                    disabled={busy}
                    aria-label="Edit this question and ask again"
                    title="Edit"
                  >
                    <IconEdit />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onResubmit(turn.question, { turnId: turn.turnId!, localId: turn.id })
                    }
                    disabled={busy}
                    aria-label="Ask this question again"
                    title="Ask again"
                  >
                    <IconRerun />
                  </button>
                </>
              )}
            </div>
          )}

          <div className="answer" aria-live="polite" aria-atomic="false">
            <Answer turn={turn} mode={mode} onAsk={onAsk} busy={busy} />
            <KeepAsFeature
              turn={turn}
              conversationId={conversationId}
              onCreated={onFeatureCreated}
            />
          </div>
        </article>
      ))}
      <div ref={endRef} />
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { Mode } from '../theme';
import type { Turn, TraceStep } from '../types';
import { forecastChart, inferChart, parseAnswer, rowsForChart } from '../answer';
import { exportAsPdf, exportRowsAsCsv, provenanceFrom } from '../export';
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
function Waiting() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const stage =
    secs < 3 ? 'Choosing the right views…'
      : secs < 8 ? 'Running the query…'
        : 'Writing the answer…';

  return (
    <div className="thinking-wrap">
      <div className="thinking" role="status">
        <span className="dots" aria-hidden><i /><i /><i /></span>
        {stage}
        <span className="elapsed">{secs}s</span>
      </div>
      <div className="thinking-track" aria-hidden />
      {secs >= 20 && (
        <div className="thinking-note">
          Still going — the free-tier model queues under load. A paid key
          answers this in a few seconds.
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

function Answer({ turn, mode }: { turn: Turn; mode: Mode }) {
  if (turn.pending) return <Waiting />;
  if (turn.error) {
    return <div className="error">{turn.error}</div>;
  }
  if (!turn.result) return null;

  const { text, chart: given } = parseAnswer(turn.result.answer);
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
              title={a.truncated ? 'Shown up to the context limit for this turn' : undefined}
            >
              {a.filename}
              {a.truncated && <span className="attachment-chip-flag">truncated</span>}
            </span>
          ))}
        </div>
      )}
      <SqlInspector trace={turn.result.trace} hops={turn.result.hops} />
    </>
  );
}

export function ChatPanel({
  turns, mode, conversationId, onFeatureCreated, onResubmit, busy,
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

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
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
                {turn.sentAttachments.map((a) => (
                  <span key={a.id} className="question-file" title={a.filename}>
                    <IconFile />
                    {a.filename}
                  </span>
                ))}
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
            <Answer turn={turn} mode={mode} />
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

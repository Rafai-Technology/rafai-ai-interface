import { useEffect, useRef, useState } from 'react';
import type { Mode } from '../theme';
import type { Turn, TraceStep } from '../types';
import { forecastChart, inferChart, parseAnswer, rowsForChart } from '../answer';
import { exportAsPdf, exportRowsAsCsv, provenanceFrom } from '../export';
import { ChartRenderer } from './ChartRenderer';
import { ExportFileCard } from './ExportFileCard';
import { Markdown } from './Markdown';
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

  return (
    <>
      <Markdown text={text} />
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

export function ChatPanel({ turns, mode }: Props) {
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
            {turn.question}
          </div>
          <div className="answer" aria-live="polite" aria-atomic="false">
            <Answer turn={turn} mode={mode} />
          </div>
        </article>
      ))}
      <div ref={endRef} />
    </div>
  );
}

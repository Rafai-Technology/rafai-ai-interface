import { useState } from 'react';
import type { TraceStep } from '../types';

/**
 * Non-negotiable for trust: when an answer looks wrong, somebody has to be able
 * to see why. Refusals are shown here too — a blocked query is the most
 * interesting thing this panel ever displays.
 */
/** "8.4 s", "42 s", "1 min 29 s". */
export function formatSeconds(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  const whole = Math.round(s);
  if (whole < 60) return `${whole} s`;
  const min = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest ? `${min} min ${rest} s` : `${min} min`;
}

export function SqlInspector({
  trace,
  hops,
  durationMs = null,
  defaultOpen = false,
}: {
  trace: TraceStep[];
  hops: number;
  /** How long the user waited for the answer. Null on older saved turns. */
  durationMs?: number | null;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  /* The database's share of the wait, so a slow answer says whether it was
     the queries or the model: ARCO's 89 s answer was 67 s of SQL. */
  const sqlMs = trace.reduce((sum, s) => sum + (s.tool === 'run_sql' ? s.durationMs ?? 0 : 0), 0);
  const timing =
    durationMs != null
      ? formatSeconds(durationMs) + (sqlMs > 0 ? ` (SQL ${formatSeconds(sqlMs)})` : '')
      : null;
  const timingTitle =
    'Time from sending the question to the finished answer. SQL is the part spent in the database.';

  if (!trace.length) {
    return timing ? (
      <div className="answer-time" title={timingTitle}>Answered in {timing}</div>
    ) : null;
  }

  // Counted separately. They are different events and lumping them together
  // made a suppressed result look like a refused one, which is the opposite of
  // reassuring when someone is reading the trail to understand what happened.
  const blocked = trace.filter((s) => s.status === 'blocked').length;
  const suppressed = trace.filter((s) => s.status === 'suppressed').length;
  /* Server-run tools (diagnose_process and the like) send their own
     statements; they count, or an answer built on five queries says "0". */
  const queries = trace.reduce(
    (n, s) => n + (s.tool === 'run_sql' ? 1 : s.sql ? s.queryCount ?? 1 : 0),
    0,
  );

  return (
    <div className="inspector">
      <button
        className="inspector-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={`caret ${open ? 'open' : ''}`} aria-hidden>▸</span>
        View SQL
        <span className="inspector-meta">
          {queries} {queries === 1 ? 'query' : 'queries'} · {hops} {hops === 1 ? 'step' : 'steps'}
          {timing && <span className="inspector-time" title={timingTitle}>· {timing}</span>}
          {blocked > 0 && (
            /* Deliberately does NOT say "outside this role's access". Most
               refusals are not access refusals at all — SELECT *, an
               unparseable statement and a banned function all land here, and
               telling someone their role was too junior when the data was
               fully available to them is the single most damaging thing this
               panel could get wrong. The per-step reason below says which. */
            <span className="badge badge-blocked" title="Refused before it reached the database — open for the reason">
              {blocked} refused
            </span>
          )}
          {suppressed > 0 && (
            <span
              className="badge badge-suppressed"
              title="Held back: the result contained a group too small to report"
            >
              {suppressed} held back
            </span>
          )}
        </span>
      </button>

      {/* Always mounted rather than conditionally rendered, so opening and
          closing can animate through a grid-rows transition instead of the
          panel popping in and out at full height. */}
      <div className={`inspector-body${open ? ' open' : ''}`}>
        <div className="inspector-body-inner">
          <ol className="steps">
            {trace.map((step, i) => (
              <li key={i} className={`step step-${step.status}`}>
                <div className="step-head">
                  <span className={`dot dot-${step.status}`} aria-hidden />
                  <span className="step-tool">{step.tool}</span>
                  {step.intent && <span className="step-intent">{step.intent}</span>}
                  <span className="step-stats">
                    {step.status === 'ok' && step.rowCount != null && (
                      <>{step.rowCount.toLocaleString('en-IN')} rows</>
                    )}
                    {step.durationMs != null && <> · {step.durationMs} ms</>}
                    {step.status !== 'ok' && (
                      <span className="step-reason">
                        {step.reason ??
                          (step.status === 'suppressed'
                            ? 'held back — group too small to report'
                            : step.status === 'blocked'
                              ? 'refused before it reached the database'
                              : step.status)}
                      </span>
                    )}
                  </span>
                </div>
                {step.sql && <pre className="sql">{step.sql}</pre>}
                {step.formula && step.formula.length > 0 && (
                  <>
                    <p className="step-label">How it was calculated</p>
                    <pre className="sql formula">{step.formula.join('\n')}</pre>
                  </>
                )}
                {step.sourceSql && (
                  <>
                    <p className="step-label">Series taken from this query</p>
                    <pre className="sql">{step.sourceSql}</pre>
                  </>
                )}
                {step.logicSources && step.logicSources.length > 0 && (
                  <div className="logic-sources">
                    {/* Reference material, not a query result — deliberately
                        styled and labelled differently from a SQL block so it
                        never reads as "this ran and returned rows". */}
                    <p className="logic-sources-label">
                      Web Trans logic consulted (read-only, not executed):
                    </p>
                    {step.logicSources.map((src) => (
                      <details key={src.name} className="logic-source">
                        <summary>
                          <code>{src.name}</code>
                          <span className="logic-source-type">{src.type}</span>
                          {src.truncated && (
                            <span className="logic-source-truncated" title="Shown up to the length cap">
                              truncated
                            </span>
                          )}
                        </summary>
                        <pre className="sql">{src.definition}</pre>
                      </details>
                    ))}
                  </div>
                )}
                {step.tool === 'search_business_logic' &&
                  (!step.logicSources || step.logicSources.length === 0) && (
                    <p className="logic-sources-empty">No matching procedure found within this role's access.</p>
                  )}
                {step.exportRequest && (
                  <p className="logic-sources-empty">
                    Requested: {step.exportRequest.format.toUpperCase()} — "{step.exportRequest.title}"
                  </p>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import type { TraceStep } from '../types';

/**
 * Non-negotiable for trust: when an answer looks wrong, somebody has to be able
 * to see why. Refusals are shown here too — a blocked query is the most
 * interesting thing this panel ever displays.
 */
export function SqlInspector({
  trace,
  hops,
  defaultOpen = false,
}: {
  trace: TraceStep[];
  hops: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!trace.length) return null;

  // Counted separately. They are different events and lumping them together
  // made a suppressed result look like a refused one, which is the opposite of
  // reassuring when someone is reading the trail to understand what happened.
  const blocked = trace.filter((s) => s.status === 'blocked').length;
  const suppressed = trace.filter((s) => s.status === 'suppressed').length;
  const queries = trace.filter((s) => s.tool === 'run_sql').length;

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
          {blocked > 0 && (
            <span className="badge badge-blocked" title="Refused: outside this role's access">
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
                              ? 'refused — outside this role'
                              : step.status)}
                      </span>
                    )}
                  </span>
                </div>
                {step.sql && <pre className="sql">{step.sql}</pre>}
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

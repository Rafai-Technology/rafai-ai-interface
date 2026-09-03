import { useState } from 'react';
import type { Finding } from '../types';

/**
 * The findings segment.
 *
 * Every string rendered here was computed server-side from SQL. Nothing is
 * reworded in the browser and nothing is inferred from the prose above it, so
 * what a reader acts on is what was measured.
 *
 * The card is built around the FIGURE, not around the sentences. A reader
 * scanning this panel is looking for a number and a next step; the measurement,
 * the trend and the benchmark are the qualification they read second, once one
 * of the numbers has caught them. An earlier version set all four as equal rows
 * of prose, which read as a paragraph with labels and gave the eye nowhere to
 * land.
 */

const SEVERITY: Record<Finding['severity'], { label: string; glyph: string }> = {
  /* Severity carries a WORD and a shape, never colour alone -- the palette is
     unreadable to a red/green-blind reader and invisible in print. */
  critical: { label: 'Critical', glyph: '●' },
  high: { label: 'High', glyph: '▲' },
  medium: { label: 'Watch', glyph: '■' },
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="insight-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function FindingCard({ finding }: { finding: Finding }) {
  const [showEvidence, setShowEvidence] = useState(false);
  const sev = SEVERITY[finding.severity];

  return (
    <article className={`insight insight-${finding.severity}`}>
      <div className="insight-bar" aria-hidden="true" />

      <div className="insight-main">
        <header className="insight-head">
          <span className="insight-sev">
            <span className="insight-glyph" aria-hidden="true">{sev.glyph}</span>
            <span className="sr-only">Severity: </span>{sev.label}
          </span>
          <h4 className="insight-title">{finding.title}</h4>
        </header>

        {finding.headline && (
          <div className="insight-figure">
            <span className="insight-value">{finding.headline.value}</span>
            {finding.delta && (
              /* Direction is drawn as an arrow AND stated in the text, so the
                 colour is the third signal rather than the only one. */
              <span className={`insight-delta ${finding.delta.is_good ? 'good' : 'bad'}`}>
                <span aria-hidden="true">{finding.delta.direction === 'down' ? '↓' : '↑'}</span>
                {finding.delta.value}
              </span>
            )}
            <span className="insight-figure-label">{finding.headline.label}</span>
          </div>
        )}

        <dl className="insight-body">
          <Row label="Measured">{finding.measured}</Row>
          {finding.trend && <Row label="Trend">{finding.trend}</Row>}
          {finding.benchmark && <Row label="Already achieved">{finding.benchmark}</Row>}
          <Row label="What it costs">{finding.impact}</Row>
        </dl>

        <div className="insight-do">
          <span className="insight-do-label">Suggested next step</span>
          <p>{finding.recommendation}</p>
        </div>

        {finding.evidence.length > 0 && (
          <div className="insight-evidence">
            <button
              type="button"
              onClick={() => setShowEvidence((v) => !v)}
              aria-expanded={showEvidence}
            >
              <span className="insight-caret" aria-hidden="true">{showEvidence ? '▾' : '▸'}</span>
              How this was measured
            </button>
            {showEvidence && (
              <ul>
                {finding.evidence.map((e, i) => (
                  <li key={i}><code>{e}</code></li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export function InsightsPanel({ findings }: { findings: Finding[] }) {
  if (!findings.length) return null;

  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <section className="insights" aria-label="Process findings">
      <div className="insights-head">
        <div className="insights-title">
          <h3>What I found</h3>
          <span className="insights-sub">measured from this database, under your own access</span>
        </div>
        <div className="insights-tally">
          {(['critical', 'high', 'medium'] as const)
            .filter((s) => counts[s])
            .map((s) => (
              <span key={s} className={`tally tally-${s}`}>
                <span aria-hidden="true">{SEVERITY[s].glyph}</span>
                {counts[s]} {SEVERITY[s].label.toLowerCase()}
              </span>
            ))}
        </div>
      </div>

      <div className="insights-list">
        {findings.map((f) => (
          <FindingCard key={f.id} finding={f} />
        ))}
      </div>

      <p className="insights-foot">
        Figures come from the queries shown below, not from the summary above them.
      </p>
    </section>
  );
}

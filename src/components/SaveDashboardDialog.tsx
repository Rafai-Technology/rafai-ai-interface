import { useState } from 'react';
import type { ChartSpec, NewPanel, TraceStep, Turn } from '../types';
import { forecastChart, inferChart, parseAnswer, rowsForChart } from '../answer';
import { createDashboard } from '../api';

/**
 * Turn a finished answer into dashboard panels.
 *
 * Takes the QUERIES the answer ran, never the rows it got back. That is the
 * whole point of the feature: a saved panel re-runs its query every time the
 * dashboard is opened, so the figure is today's rather than the afternoon
 * somebody pressed save.
 *
 * One panel per successful query. A question that ran three queries to reach
 * its answer becomes three panels, which is usually what the person wanted to
 * keep an eye on anyway.
 */
export function panelsFromTurn(turn: Turn): NewPanel[] {
  if (!turn.result) return [];
  const { chart: given } = parseAnswer(turn.result.answer);
  const chart: ChartSpec | null =
    forecastChart(turn.result.trace) ?? given ?? inferChart(turn.result.trace);

  const queries = turn.result.trace.filter(
    (s: TraceStep) => s.tool === 'run_sql' && s.status === 'ok' && s.sql,
  );

  return queries.map((step, i) => {
    /* The chart spec only fits the query whose columns it names — attaching it
       to every panel would draw the wrong axes on the others. */
    const rows = chart ? rowsForChart([step], chart) : null;
    return {
      title: step.intent?.trim() || `Query ${i + 1}`,
      sql: step.sql as string,
      chartSpec: rows?.length ? chart : null,
      caveats: [],
    };
  });
}

interface Props {
  turn: Turn;
  conversationId: string | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}

export function SaveDashboardDialog({ turn, conversationId, onClose, onSaved }: Props) {
  const suggested = panelsFromTurn(turn);
  const [title, setTitle] = useState(turn.question.slice(0, 120));
  const [chosen, setChosen] = useState<boolean[]>(suggested.map(() => true));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = suggested.filter((_, i) => chosen[i]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const { id } = await createDashboard({
        title: title.trim(),
        conversation_id: conversationId,
        panels: selected,
      });
      onSaved(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dlg-backdrop" role="dialog" aria-modal="true" aria-label="Create a feature">
      <div className="dlg">
        <h3 className="dlg-title">Create a feature</h3>
        <p className="dlg-sub">
          Saves the <strong>queries</strong> behind this answer, not the numbers.
          Opening it later runs them again, so it always shows current data —
          under your own branch access.
        </p>

        <label className="dlg-label" htmlFor="dash-title">Name</label>
        <input
          id="dash-title"
          className="dlg-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Monthly revenue and delivery health"
        />

        <div className="dlg-label">Panels ({selected.length} of {suggested.length})</div>
        {suggested.length === 0 ? (
          <p className="dlg-empty">
            This answer did not run a query, so there is nothing to keep live.
          </p>
        ) : (
          <ul className="dlg-panels">
            {suggested.map((p, i) => (
              <li key={i}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen[i]}
                    onChange={() =>
                      setChosen((c) => c.map((v, j) => (j === i ? !v : v)))}
                  />
                  <span className="dlg-panel-title">{p.title}</span>
                  {p.chartSpec && <span className="dlg-chip">{p.chartSpec.type}</span>}
                </label>
                <code className="dlg-sql">{p.sql}</code>
              </li>
            ))}
          </ul>
        )}

        {error && <div className="dlg-error">{error}</div>}

        <div className="dlg-actions">
          <button type="button" className="btn-quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={save}
            disabled={busy || !title.trim() || selected.length === 0}
          >
            {busy ? 'Creating…' : 'Create feature'}
          </button>
        </div>
      </div>
    </div>
  );
}

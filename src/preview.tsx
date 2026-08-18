/**
 * Throwaway harness for eyeballing answer rendering and the chart forms
 * without spending API calls. Not part of the app.
 */
import { createRoot } from 'react-dom/client';
import { ChatPanel } from './components/ChatPanel';
import { Markdown } from './components/Markdown';
import type { Mode } from './theme';
import type { Turn } from './types';
import sample from './sample-answer.json';
import './styles.css';

const mode: Mode =
  new URLSearchParams(location.search).get('mode') === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.theme = mode;

const turns: Turn[] = [
  {
    id: '1',
    question: 'What is our total outstanding, bucketed by ageing?',
    role: 'ACCOUNTS',
    pending: false,
    result: sample as any,
  },
];

/** Malformed shapes the model will eventually produce. None may throw. */
const EDGE_CASES: [string, string][] = [
  ['plain text', 'Just a plain sentence, no formatting at all.'],
  ['table missing trailing pipes', '| Branch | LRs\n|---|---|\n| Pune | 763'],
  ['bold inside cells', '| Bucket | Amount |\n|---|---|\n| **90+ days** | **Rs 78,36,657** |'],
  ['unclosed bold', 'This has **an unclosed bold run and then stops'],
  ['list then table', '- first\n- second\n\n| A | B |\n|---|---|\n| 1 | 2 |'],
  ['heading + numbered list', '## Findings\n1. Hyderabad at 76%\n2. Pune at 88%'],
  ['ragged table rows', '| A | B | C |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |'],
  ['inline code and rule', 'Use `vw_consignment_detail`.\n\n---\n\nDone.'],
];

createRoot(document.getElementById('root')!).render(
  <div className="shell" style={{ gridTemplateColumns: '1fr' }}>
    <div className="workspace">
      <div className="scroll">
        <ChatPanel turns={turns} mode={mode} />
        <hr className="md-rule" />
        <h3 style={{ fontSize: 13, margin: '18px 0 10px' }}>Renderer edge cases</h3>
        {EDGE_CASES.map(([name, md]) => (
          <div key={name} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--muted)', marginBottom: 4 }}>{name}</div>
            <Markdown text={md} />
          </div>
        ))}
      </div>
    </div>
  </div>,
);

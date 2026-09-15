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


/**
 * One turn per chart form, on data shaped like the real thing — long Indian
 * branch and vendor names, part-load weights, hire costs — because the forms
 * that break are the ones fed short tidy labels in a harness and long ones in
 * production.
 */
function chartTurn(
  id: string, question: string, type: string, x: string, y: string[],
  title: string, rows: Record<string, any>[],
): Turn {
  return {
    id, question, role: 'ADMIN', pending: false,
    result: {
      answer: `${title}.\n\n\`\`\`chart\n${JSON.stringify({ type, x, y, title })}\n\`\`\``,
      trace: [{ tool: 'run_sql', status: 'ok', sql: `-- ${title}`, rowCount: rows.length, rows }],
      hops: 1,
      usage: { input: 0, output: 0, cacheRead: 0 },
    } as any,
  };
}

const CHART_CASES: Turn[] = [
  chartTurn('c1', 'Which branches carry the highest line-haul cost?', 'bar',
    'branch', ['hire_cost'], 'Line-haul cost by branch', [
      { branch: 'HUB DELHI', hire_cost: 14736141 },
      { branch: 'HUB PUNE', hire_cost: 14379463 },
      { branch: 'SURAT SAROLI', hire_cost: 1853006 },
      { branch: 'DILSHAD GARDEN', hire_cost: 394851 },
      { branch: 'HUB ASLALI', hire_cost: 331446 },
      { branch: 'KAMLA MARKET', hire_cost: 229380 },
      { branch: 'VIJAYAWADA BHAVANIPURAM', hire_cost: 188220 },
    ]),
  chartTurn('c2', 'Split line-haul charges by component and month', 'stacked',
    'month', ['freight', 'advance', 'balance'], 'Charge components by month', [
      { month: '2026-04', freight: 8100000, advance: 900000, balance: 7200000 },
      { month: '2026-05', freight: 8600000, advance: 1100000, balance: 7500000 },
      { month: '2026-06', freight: 8300000, advance: 800000, balance: 7500000 },
      { month: '2026-07', freight: 8400000, advance: 870000, balance: 7530000 },
    ]),
  chartTurn('c3', 'Which vendors account for most of our hire spend?', 'pareto',
    'vendor', ['spend'], 'Vendor spend, ranked', [
      { vendor: 'CTS EXPRESS LOGISTICS PVT LTD', spend: 16793701 },
      { vendor: 'CTS EXPRESS FREIGHT LLP', spend: 6299554 },
      { vendor: 'CTS FLEET VV', spend: 5236057 },
      { vendor: 'MARKET VEHICLE', spend: 4579676 },
      { vendor: 'CHINTAMANI TRANSPORT', spend: 323154 },
      { vendor: 'MADAN SHAIKH', spend: 60000 },
      { vendor: 'PRAMOD MANDAL VV', spend: 51910 },
      { vendor: 'HARSH MISHRA', spend: 30349 },
    ]),
  chartTurn('c4', 'How does load compare with rated capacity?', 'scatter',
    'capacity_kg', ['load_kg'], 'Load against rated capacity', [
      { capacity_kg: 3000, load_kg: 1776 }, { capacity_kg: 7000, load_kg: 2632 },
      { capacity_kg: 30000, load_kg: 5610 }, { capacity_kg: 16000, load_kg: 4976 },
      { capacity_kg: 5000, load_kg: 3020 }, { capacity_kg: 15000, load_kg: 2025 },
      { capacity_kg: 21000, load_kg: 8400 }, { capacity_kg: 3000, load_kg: 6389 },
      { capacity_kg: 5000, load_kg: 15164 }, { capacity_kg: 7000, load_kg: 6900 },
      { capacity_kg: 30000, load_kg: 22400 }, { capacity_kg: 16000, load_kg: 3100 },
    ]),
  chartTurn('c5', 'Monthly hire cost', 'line',
    'month', ['hire_cost'], 'Hire cost by month', [
      { month: '2026-04', hire_cost: 8100000 }, { month: '2026-05', hire_cost: 8600000 },
      { month: '2026-06', hire_cost: 8300000 }, { month: '2026-07', hire_cost: 8400000 },
    ]),
];

createRoot(document.getElementById('root')!).render(
  <div className="shell" style={{ gridTemplateColumns: '1fr' }}>
    <div className="workspace">
      <div className="scroll">
        <ChatPanel turns={turns} mode={mode} />
        <hr className="md-rule" />
        <h3 style={{ fontSize: 13, margin: '18px 0 10px' }}>Chart forms</h3>
        <ChatPanel turns={CHART_CASES} mode={mode} />
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

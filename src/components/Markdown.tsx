import { Fragment, type ReactNode } from 'react';

/**
 * A small renderer for the Markdown the model actually produces: headings,
 * bold, inline code, bullet and numbered lists, and GFM tables.
 *
 * Hand-written rather than a library because the subset is narrow and this
 * builds React elements directly — nothing is ever passed to innerHTML, so a
 * customer name containing angle brackets cannot become markup.
 */

const BOLD = /\*\*(.+?)\*\*/;
const ITALIC = /(?<![*\w])\*([^*\n]+)\*(?!\*)/;
const CODE = /`([^`]+)`/;

/** Splits one line into bold / italic / code / text nodes. */
function inline(text: string, keyPrefix = ''): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let i = 0;

  while (rest) {
    const bold = BOLD.exec(rest);
    const code = CODE.exec(rest);
    const italic = ITALIC.exec(rest);

    const candidates = [
      bold && { at: bold.index, m: bold, kind: 'b' as const },
      code && { at: code.index, m: code, kind: 'c' as const },
      italic && { at: italic.index, m: italic, kind: 'i' as const },
    ].filter(Boolean) as { at: number; m: RegExpExecArray; kind: 'b' | 'c' | 'i' }[];

    if (!candidates.length) {
      out.push(rest);
      break;
    }

    const next = candidates.sort((a, b) => a.at - b.at)[0];
    if (next.at > 0) out.push(rest.slice(0, next.at));

    const key = `${keyPrefix}-${i++}`;
    const body = next.m[1];
    if (next.kind === 'b') out.push(<strong key={key}>{body}</strong>);
    else if (next.kind === 'c') out.push(<code key={key}>{body}</code>);
    else out.push(<em key={key}>{body}</em>);

    rest = rest.slice(next.at + next.m[0].length);
  }

  return out;
}

const NUMERIC = /^[\s(]*(₹|rs\.?|inr)?\s*-?[\d,]+(\.\d+)?\s*(%|cr|crore|l|lakh|k|days?)?[\s)]*$/i;

function isNumericColumn(rows: string[][], col: number): boolean {
  const cells = rows.map((r) => r[col] ?? '').filter((c) => c.trim() && c.trim() !== '—');
  return cells.length > 0 && cells.every((c) => NUMERIC.test(c.replace(/\*\*/g, '')));
}

/**
 * Indian digit grouping, applied in the UI rather than asked of the model.
 * A prompt rule about lakh formatting is complied with unevenly; this is
 * deterministic and works the same whichever model is behind the answer.
 * Only touches plain magnitudes — years, percentages, LR numbers and dates
 * are left exactly as written.
 */
const PLAIN_NUMBER = /^(₹|Rs\.?\s?|INR\s?)?\s*(\d[\d,]*)(\.\d+)?$/i;

function indianGrouping(cell: string): string {
  const m = PLAIN_NUMBER.exec(cell.trim());
  if (!m) return cell;
  const digits = m[2].replace(/,/g, '');
  if (digits.length < 5) return cell;           // years and small counts
  const n = Number(digits);
  if (!Number.isFinite(n)) return cell;
  const grouped = n.toLocaleString('en-IN');
  return `${m[1] ? m[1].trim() + ' ' : ''}${grouped}${m[3] ?? ''}`;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:-]*-{2,}[\s:|-]*\|?\s*$/.test(line) && line.includes('-');
}

function Table({ lines, k }: { lines: string[]; k: string }) {
  const header = splitRow(lines[0]);
  const body = lines.slice(2).map(splitRow);
  const numeric = header.map((_, i) => isNumericColumn(body, i));

  return (
    <div className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>
            {header.map((h, i) => (
              <th key={i} className={numeric[i] ? 'num' : undefined}>
                {inline(h, `${k}h${i}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {header.map((_, c) => (
                <td key={c} className={numeric[c] ? 'num' : undefined}>
                  {inline(
                    numeric[c] ? indianGrouping(row[c] ?? '') : (row[c] ?? ''),
                    `${k}c${r}-${c}`,
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];

  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Table: a header row followed by a --- separator.
    if (line.trim().startsWith('|') && isTableSeparator(lines[i + 1] ?? '')) {
      const start = i;
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) i++;
      blocks.push(<Table key={key++} k={`t${key}`} lines={lines.slice(start, i)} />);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      const Tag = (['h3', 'h4', 'h5', 'h5'] as const)[level - 1];
      blocks.push(<Tag key={key++} className="md-h">{inline(heading[2], `h${key}`)}</Tag>);
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="md-rule" />);
      i++;
      continue;
    }

    const bulleted = /^\s*[-*•]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;

    if (bulleted.test(line)) {
      const items: string[] = [];
      while (i < lines.length && bulleted.test(lines[i])) {
        items.push(lines[i].replace(bulleted, ''));
        i++;
      }
      blocks.push(
        <ul key={key++}>
          {items.map((it, n) => <li key={n}>{inline(it, `u${key}-${n}`)}</li>)}
        </ul>,
      );
      continue;
    }

    if (numbered.test(line)) {
      const items: string[] = [];
      while (i < lines.length && numbered.test(lines[i])) {
        items.push(lines[i].replace(numbered, ''));
        i++;
      }
      blocks.push(
        <ol key={key++}>
          {items.map((it, n) => <li key={n}>{inline(it, `o${key}-${n}`)}</li>)}
        </ol>,
      );
      continue;
    }

    // Paragraph: consecutive non-blank lines that start no other block.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !bulleted.test(lines[i]) &&
      !numbered.test(lines[i]) &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !lines[i].trim().startsWith('|')
    ) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push(
      <p key={key++}>
        {para.map((l, n) => (
          <Fragment key={n}>
            {n > 0 && ' '}
            {inline(l, `p${key}-${n}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className="prose">{blocks}</div>;
}

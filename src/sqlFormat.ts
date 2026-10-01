/**
 * Lays a one-line query out over several lines, for reading only.
 *
 * The model writes its SQL as a single line, and shown as written a query ran
 * off the side of the panel: a reader saw "SELECT TOP (2000) branch_name, ..."
 * and had to scroll sideways to find the filter. This breaks it at its
 * clauses, one SELECT column and one AND/OR condition per line.
 *
 * Only whitespace between tokens ever changes. Strings, [bracketed] and
 * "quoted" names and comments are copied through untouched, so what is shown
 * (and copied) runs exactly as the original did. A query that already has
 * line breaks was laid out by whoever wrote it and is left alone.
 */

type Token = { kind: 'space' | 'word' | 'open' | 'close' | 'comma' | 'other'; text: string };

/** Clauses that start a line of their own. */
const CLAUSES = new Set(['SELECT', 'FROM', 'WHERE', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT', 'OFFSET']);
/** Two-word clauses, keyed by their first word. */
const PAIRED: Record<string, string> = { GROUP: 'BY', ORDER: 'BY' };
/** Words that can open a join: LEFT OUTER JOIN, CROSS APPLY and so on. */
const JOIN_LEAD = new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER']);

function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const until = (end: string, from: number, doubled: boolean): number => {
    let j = from;
    for (;;) {
      const k = sql.indexOf(end, j);
      if (k === -1) return sql.length;
      // '' inside a string and ]] inside a bracketed name are escapes.
      if (doubled && sql.startsWith(end + end, k)) { j = k + 2; continue; }
      return k + end.length;
    }
  };
  while (i < sql.length) {
    const c = sql[i];
    let j: number;
    let kind: Token['kind'] = 'other';
    if (/\s/.test(c)) {
      j = i + 1;
      while (j < sql.length && /\s/.test(sql[j])) j++;
      kind = 'space';
    } else if (c === "'") j = until("'", i + 1, true);
    else if (c === '[') j = until(']', i + 1, true);
    else if (c === '"') j = until('"', i + 1, true);
    else if (sql.startsWith('--', i)) j = sql.length;
    else if (sql.startsWith('/*', i)) j = until('*/', i + 2, false);
    else if (c === '(') { j = i + 1; kind = 'open'; }
    else if (c === ')') { j = i + 1; kind = 'close'; }
    else if (c === ',') { j = i + 1; kind = 'comma'; }
    else if (/[\w@#$]/.test(c)) {
      j = i + 1;
      while (j < sql.length && /[\w@#$.]/.test(sql[j])) j++;
      kind = 'word';
    } else j = i + 1;
    out.push({ kind, text: sql.slice(i, j) });
    i = j;
  }
  return out;
}

export function formatSql(sql: string): string {
  const text = sql.trim();
  if (text.includes('\n')) return text;

  const tokens = tokenize(text);
  const words = tokens.map((t) => (t.kind === 'word' ? t.text.toUpperCase() : ''));
  /** The next word after index i, skipping whitespace. */
  const nextWord = (i: number): string => {
    for (let k = i + 1; k < tokens.length; k++) {
      if (tokens[k].kind === 'space') continue;
      return words[k];
    }
    return '';
  };

  let out = '';
  let depth = 0;
  /** The clause open at each parenthesis depth, for deciding comma breaks. */
  const clauseAt: string[] = [''];
  /** CASE ... END nesting per depth: AND inside a CASE stays on its line. */
  const caseAt: number[] = [0];
  let pendingBetween = false;
  let skipSpace = false;
  let lastSignificant: Token | null = null;

  const indent = (extra: number) => '  '.repeat(depth + extra);
  const newline = (extra: number) => {
    out = out.replace(/ +$/, '') + '\n' + indent(extra);
    skipSpace = true;
  };

  tokens.forEach((t, i) => {
    if (t.kind === 'space') {
      if (!skipSpace && out && !out.endsWith(' ')) out += ' ';
      return;
    }
    skipSpace = false;
    const w = words[i];
    const atStart = out.length === 0;
    const afterOpen = lastSignificant?.kind === 'open';

    if (t.kind === 'word') {
      let clause: string | null = null;
      if (CLAUSES.has(w)) clause = w;
      else if (PAIRED[w] && nextWord(i) === PAIRED[w]) clause = w;
      else if (w === 'JOIN' && !JOIN_LEAD.has(prevWord(i))) clause = 'JOIN';
      else if (JOIN_LEAD.has(w) && !JOIN_LEAD.has(prevWord(i)) && joinsAhead(i)) clause = 'JOIN';

      if (clause) {
        if (!atStart && !afterOpen) newline(0);
        clauseAt[depth] = clause;
      } else if (w === 'BETWEEN') {
        pendingBetween = true;
      } else if (w === 'CASE') {
        caseAt[depth] = (caseAt[depth] ?? 0) + 1;
      } else if (w === 'END' && caseAt[depth] > 0) {
        caseAt[depth]--;
      } else if ((w === 'AND' || w === 'OR') && !caseAt[depth]) {
        if (w === 'AND' && pendingBetween) pendingBetween = false;
        else if (['WHERE', 'HAVING', 'JOIN'].includes(clauseAt[depth])) newline(1);
      }
    }

    if (t.kind === 'open') {
      out += t.text;
      depth++;
      clauseAt[depth] = '';
      caseAt[depth] = 0;
    } else if (t.kind === 'close') {
      depth = Math.max(0, depth - 1);
      out = out.replace(/ +$/, '') + t.text;
    } else if (t.kind === 'comma') {
      out = out.replace(/ +$/, '') + t.text;
    } else {
      out += t.text;
    }
    // A break made before this token is spent; the space after it stays.
    skipSpace = false;
    if (t.kind === 'comma' && clauseAt[depth] === 'SELECT' && !caseAt[depth]) newline(1);
    lastSignificant = t;
  });
  return out;

  function prevWord(i: number): string {
    for (let k = i - 1; k >= 0; k--) {
      if (tokens[k].kind === 'space') continue;
      return words[k];
    }
    return '';
  }
  /** LEFT, CROSS etc. open a join only when JOIN or APPLY follows within two words. */
  function joinsAhead(i: number): boolean {
    let seen = 0;
    for (let k = i + 1; k < tokens.length && seen < 2; k++) {
      if (tokens[k].kind === 'space') continue;
      seen++;
      if (words[k] === 'JOIN' || words[k] === 'APPLY') return true;
      if (!JOIN_LEAD.has(words[k])) return false;
    }
    return false;
  }
}

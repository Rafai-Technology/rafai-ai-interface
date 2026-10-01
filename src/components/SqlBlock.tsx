import { useState } from 'react';
import { formatSql } from '../sqlFormat';
import { IconCheck, IconCopy } from './icons';

/**
 * A query as shown in the trail: laid out over lines, with a copy button.
 *
 * What is copied is what is shown. formatSql only moves whitespace, so the
 * copied query runs exactly as the original did, and is the readable one to
 * paste into SSMS.
 */
export function SqlBlock({
  sql,
  className = 'sql',
  format = true,
}: {
  sql: string;
  className?: string;
  /** False for text that is not a query, such as a forecast's formula. */
  format?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const shown = format ? formatSql(sql) : sql;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* Clipboard access refused (insecure origin, permissions policy). The
         icon staying unchanged is the honest signal that nothing was copied. */
    }
  };

  return (
    <div className="sql-block">
      <pre className={className}>{shown}</pre>
      <button
        type="button"
        className={`sql-copy${copied ? ' is-copied' : ''}`}
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy'}
        title={copied ? 'Copied' : 'Copy'}
      >
        {copied ? <IconCheck /> : <IconCopy />}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  );
}

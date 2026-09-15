import { useState } from 'react';
import { slug } from '../export';
import { IconDownload, IconFile } from './icons';

type Format = 'csv' | 'pdf' | 'png';

const KIND: Record<Format, string> = { csv: 'Spreadsheet', pdf: 'Report', png: 'Image' };

interface Props {
  format: Format;
  title: string;
  /** How many data rows the file will contain, when it contains a table. */
  rowCount?: number;
  /** Whether the chart is drawn into the file. */
  hasChart?: boolean;
  /** How many SQL statements travel with it, for formats that carry them. */
  queryCount?: number;
  /** How many caveats are written alongside the figures. */
  caveatCount?: number;
  onDownload: () => void | Promise<void>;
}

/**
 * A file the user asked for, shown as something to open when they choose to —
 * never pushed to the downloads folder the moment the answer renders. The card
 * names the exact file before it exists; building it (rasterizing a chart,
 * laying out a PDF) only happens on click, so an answer nobody downloads never
 * pays that cost.
 *
 * It also says what is INSIDE. A PDF from here is not just a picture of the
 * chart: it carries the table, the caveats and the SQL that produced the
 * figures. Somebody deciding whether to send it to a customer needs to know
 * that before they click, not after.
 */
export function ExportFileCard({
  format, title, rowCount, hasChart, queryCount, caveatCount, onDownload,
}: Props) {
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');

  /* Stem and extension are separate elements so the ellipsis can only ever eat
     the stem. Truncating the whole string produced
     "delivered-consignments-report-fy-20…", which hides the one part of a
     filename that says what the thing IS. */
  const stem = slug(title);
  const filename = `${stem}.${format}`;

  /**
   * Only what this format actually carries. A CSV is rows and nothing else;
   * claiming it holds the chart or the SQL would be a lie told by a label.
   */
  const contents: string[] = [];
  if (format !== 'png' && rowCount) {
    contents.push(`${rowCount.toLocaleString('en-IN')} ${rowCount === 1 ? 'row' : 'rows'}`);
  }
  if (format !== 'csv' && hasChart) contents.push('chart');
  if (format === 'pdf' && queryCount) {
    contents.push(`${queryCount} ${queryCount === 1 ? 'query' : 'queries'}`);
  }
  if (format === 'pdf' && caveatCount) {
    contents.push(`${caveatCount} ${caveatCount === 1 ? 'note' : 'notes'}`);
  }

  const handleClick = async () => {
    if (state === 'working') return;
    setState('working');
    try {
      await onDownload();
      setState('idle');
    } catch {
      setState('error');
    }
  };

  return (
    <div className={`export-card${state === 'error' ? ' has-error' : ''}`}>
      <span className={`export-card-icon export-card-icon-${format}`} aria-hidden="true">
        <IconFile />
        <span className="export-card-badge">{format.toUpperCase()}</span>
      </span>

      <span className="export-card-body">
        <span className="export-card-name">
          <span className="export-card-stem">{stem}</span>
          <span className="export-card-ext">.{format}</span>
        </span>
        <span className={`export-card-meta${state === 'error' ? ' error' : ''}`}>
          {state === 'error'
            ? 'Could not build the file — try again'
            : [KIND[format], ...contents].join(' · ')}
        </span>
      </span>

      {/* A labelled button, not a bare glyph. This is the one action on the
          card and it should read as one before it is hovered. */}
      <button
        type="button"
        className="export-card-btn"
        onClick={handleClick}
        disabled={state === 'working'}
        aria-label={`Download ${filename}`}
      >
        {state === 'working' ? (
          <>
            <span className="export-card-spin" aria-hidden="true" />
            Preparing
          </>
        ) : (
          <>
            <IconDownload />
            {state === 'error' ? 'Retry' : 'Download'}
          </>
        )}
      </button>
    </div>
  );
}

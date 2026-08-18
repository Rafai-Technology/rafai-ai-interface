import { useState } from 'react';
import { slug } from '../export';
import { IconDownload, IconFile } from './icons';

type Format = 'csv' | 'pdf' | 'png';

const FORMAT_LABEL: Record<Format, string> = { csv: 'CSV', pdf: 'PDF', png: 'PNG image' };

interface Props {
  format: Format;
  title: string;
  onDownload: () => void | Promise<void>;
}

/**
 * A file the user asked for, shown as something to open when they choose to —
 * never pushed to the downloads folder the moment the answer renders. The
 * card names the exact file before it exists; building it (rasterizing a
 * chart, laying out a PDF) only happens on click, so an answer nobody
 * downloads never pays that cost.
 */
export function ExportFileCard({ format, title, onDownload }: Props) {
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');
  const filename = `${slug(title)}.${format}`;

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
    <button
      type="button"
      className="export-card"
      onClick={handleClick}
      disabled={state === 'working'}
    >
      <span className={`export-card-icon export-card-icon-${format}`} aria-hidden>
        <IconFile />
      </span>
      <span className="export-card-body">
        <span className="export-card-name">{filename}</span>
        <span className="export-card-meta">
          {state === 'working'
            ? 'Preparing…'
            : state === 'error'
              ? 'Could not build the file — click to retry'
              : FORMAT_LABEL[format]}
        </span>
      </span>
      <span className="export-card-action" aria-hidden><IconDownload /></span>
    </button>
  );
}

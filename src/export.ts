/** A file this many rows or fewer downloads whole; past it, only the first
 *  MAX_EXPORT_ROWS are written and the file says so. The trace itself is
 *  already capped (TRACE_ROW_CAP on the server), so this rarely bites — it
 *  exists so a export can never silently balloon past what was ever shown. */
const MAX_EXPORT_ROWS = 5000;

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Deferred: revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A filename-safe slug, so a chart titled "Top customers by revenue?" does
 *  not fight the OS over ':' or '?' in the saved file's name. Exported so the
 *  UI can show the exact filename on a download card before it is built. */
export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'rafai-export'
  );
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(rows: Record<string, any>[], columns: string[]): string {
  const capped = rows.slice(0, MAX_EXPORT_ROWS);
  const lines = [columns.join(',')];
  for (const row of capped) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return lines.join('\r\n');
}

export function exportRowsAsCsv(
  rows: Record<string, any>[],
  columns: string[],
  title: string,
): void {
  const csv = rowsToCsv(rows, columns);
  // Byte-order mark: without it, Excel guesses the wrong encoding for any
  // non-ASCII text (a customer name with an accented character, say) and
  // shows garbled characters instead of failing loudly.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  triggerDownload(blob, `${slug(title)}.csv`);
}

/**
 * Rasterises a live Recharts <svg> to a PNG. Recharts sets nearly everything
 * that matters (stroke, fill, font-size) as inline SVG attributes rather than
 * external CSS classes, so a standalone serialization keeps its appearance —
 * the one thing not preserved is hover/active state, which a static export
 * has no use for anyway.
 */
export function svgToPngDataUrl(
  svg: SVGSVGElement,
  backgroundColor: string,
  scale = 2,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const rect = svg.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));

    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    const svgText = new XMLSerializer().serializeToString(clone);
    const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      URL.revokeObjectURL(url);
      if (!ctx) { reject(new Error('canvas unavailable')); return; }
      ctx.scale(scale, scale);
      // The SVG itself has no background — without painting one, a chart
      // exported from dark mode would show dark text on a transparent (and
      // so effectively white, once opened) PNG.
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('chart image failed to render')); };
    img.src = url;
  });
}

export async function exportChartAsPng(
  svg: SVGSVGElement,
  backgroundColor: string,
  title: string,
): Promise<void> {
  const dataUrl = await svgToPngDataUrl(svg, backgroundColor);
  const blob = await (await fetch(dataUrl)).blob();
  triggerDownload(blob, `${slug(title)}.png`);
}

/**
 * One page: title, the chart as a raster image if one was on screen, then
 * the full row data as a table. jspdf-autotable handles pagination for a
 * long result set — hand-rolled pagination is exactly the kind of thing
 * that looks fine in a demo and breaks on the first 200-row table.
 */
/** Money and counts are grouped Indian-style everywhere else in the product;
 *  a table that reads 1234567 in the exported file and Rs 12,34,567 on screen
 *  is the same number twice in two dialects. */
function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }
  // Numeric strings arrive from the driver for decimals; format those too,
  // but leave anything non-numeric (an LR number, a status) untouched.
  const s = String(v);
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    return Number(s).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }
  return s;
}

/** The SQL behind an answer, for the PDF's provenance block. Same information
 *  the on-screen inspector shows — an exported figure should be as checkable
 *  as one left on screen. Lives here rather than in a component because it is
 *  an export concern, and importing it from ChatPanel would make ChartRenderer
 *  and ChatPanel import each other. */
export function provenanceFrom(
  trace: { tool: string; status: string; sql?: string; rowCount?: number }[],
  role?: string,
): PdfProvenance {
  return {
    role,
    queries: trace
      .filter((s) => s.tool === 'run_sql' && s.status === 'ok' && s.sql)
      .map((s) => ({ sql: s.sql as string, rowCount: s.rowCount })),
  };
}

export interface PdfProvenance {
  /** The SQL actually run for this answer, in order. */
  queries?: { sql: string; rowCount?: number }[];
  /** Which role and branch scope the figures were produced under. */
  role?: string;
}

/**
 * A report, not a table dump.
 *
 * The earlier version wrote a title, a chart and the rows. That quietly
 * defeated the point of the product: every figure in this system carries
 * qualifications — a margin is a contribution before overheads, a weight is
 * the chargeable one rather than the measured one, a column may be recorded
 * on only part of the rows — and an exported file is precisely the artefact
 * that gets forwarded to someone who never saw the conversation. Sending the
 * number without its caveat turns a careful answer into a wrong one in
 * somebody else's inbox.
 *
 * So the page carries, in order: the finding, the chart, the data, the
 * caveats, and the SQL behind it. The SQL matters for the same reason it is
 * shown on screen — an answer nobody can check is an answer nobody should
 * act on.
 */
export async function exportAsPdf(opts: {
  title: string;
  chartSvg?: SVGSVGElement | null;
  chartBackground?: string;
  rows: Record<string, any>[];
  columns: string[];
  summary?: string;
  caveats?: string[];
  provenance?: PdfProvenance;
}): Promise<void> {
  const { title, chartSvg, chartBackground, rows, columns, summary, caveats, provenance } = opts;

  // Loaded on demand rather than at page load: jsPDF pulls in html2canvas and
  // dompurify internally (unused by anything this app calls), which alone
  // roughly doubled the bundle every visitor downloaded just to have a PDF
  // button available. A dynamic import turns that into its own chunk, fetched
  // only the first time someone actually asks for a PDF.
  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 32;

  const textWidth = pageWidth - margin * 2;

  doc.setFontSize(15);
  doc.text(title, margin, 38);
  doc.setFontSize(8.5);
  doc.setTextColor(130);
  doc.text(
    `Rafai AI · generated ${new Date().toLocaleString('en-IN')}` +
      (provenance?.role ? ` · role: ${provenance.role.replace(/_/g, ' ')}` : ''),
    margin,
    53,
  );
  doc.setTextColor(0);

  let cursorY = 70;

  if (summary) {
    doc.setFontSize(10.5);
    const lines = doc.splitTextToSize(summary, textWidth) as string[];
    doc.text(lines, margin, cursorY);
    cursorY += lines.length * 13 + 12;
  }

  if (chartSvg) {
    try {
      const dataUrl = await svgToPngDataUrl(chartSvg, chartBackground ?? '#ffffff', 2);
      const rect = chartSvg.getBoundingClientRect();
      const maxWidth = pageWidth - margin * 2;
      const imgWidth = Math.min(maxWidth, rect.width);
      const imgHeight = (rect.height / rect.width) * imgWidth;
      doc.addImage(dataUrl, 'PNG', margin, cursorY, imgWidth, imgHeight);
      cursorY += imgHeight + 20;
    } catch {
      // A chart that fails to rasterize should not stop the table from
      // still exporting — the data is the part that must not be lost.
    }
  }

  const capped = rows.slice(0, MAX_EXPORT_ROWS);
  if (capped.length) {
    autoTable(doc, {
      startY: cursorY,
      head: [columns.map((c) => c.replace(/_/g, ' '))],
      body: capped.map((r) => columns.map((c) => formatCell(r[c]))),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [40, 40, 40] },
      margin: { left: margin, right: margin },
    });
    cursorY = ((doc as any).lastAutoTable?.finalY ?? cursorY) + 16;
    if (rows.length > MAX_EXPORT_ROWS) {
      doc.setFontSize(8);
      doc.setTextColor(150);
      doc.text(
        `Showing the first ${MAX_EXPORT_ROWS.toLocaleString('en-IN')} of ${rows.length.toLocaleString('en-IN')} rows.`,
        margin, cursorY,
      );
      doc.setTextColor(0);
      cursorY += 16;
    }
  }

  /* Caveats are given their own headed block rather than a footnote. They are
     the difference between a figure being right and being misleading, so they
     should not read as small print. */
  if (caveats?.length) {
    if (cursorY > doc.internal.pageSize.getHeight() - 110) { doc.addPage(); cursorY = 50; }
    doc.setFontSize(10);
    doc.text('Read these figures with the following in mind', margin, cursorY);
    cursorY += 6;
    doc.setDrawColor(200);
    doc.line(margin, cursorY, margin + textWidth, cursorY);
    cursorY += 13;
    doc.setFontSize(9);
    for (const c of caveats) {
      const lines = doc.splitTextToSize(`•  ${c}`, textWidth) as string[];
      if (cursorY + lines.length * 11 > doc.internal.pageSize.getHeight() - 40) {
        doc.addPage(); cursorY = 50;
      }
      doc.text(lines, margin, cursorY);
      cursorY += lines.length * 11 + 3;
    }
    cursorY += 10;
  }

  /* The SQL, for the same reason it is shown on screen: an answer nobody can
     check is an answer nobody should act on. */
  if (provenance?.queries?.length) {
    if (cursorY > doc.internal.pageSize.getHeight() - 90) { doc.addPage(); cursorY = 50; }
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text('How this was produced', margin, cursorY);
    cursorY += 12;
    doc.setFontSize(7.5);
    for (const q of provenance.queries) {
      const label = q.rowCount != null ? `-- ${q.rowCount.toLocaleString('en-IN')} rows` : '--';
      const lines = doc.splitTextToSize(`${label}\n${q.sql}`, textWidth) as string[];
      if (cursorY + lines.length * 9 > doc.internal.pageSize.getHeight() - 30) {
        doc.addPage(); cursorY = 50;
      }
      doc.text(lines, margin, cursorY);
      cursorY += lines.length * 9 + 8;
    }
    doc.setTextColor(0);
  }

  doc.save(`${slug(title)}.pdf`);
}

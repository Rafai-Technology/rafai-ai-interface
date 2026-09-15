/**
 * Category-axis formatting, kept apart from the chart component so it is pure,
 * dependency-free and directly testable — the timezone rule below is the kind
 * of thing that must be asserted, not eyeballed on a screenshot.
 */

/**
 * A SQL Server `date` arrives as JSON as "2026-08-06T00:00:00.000Z", and putting
 * that on an axis is what produced seven 24-character labels across one card.
 * Matched strictly so an ordinary string that merely starts with digits — an LR
 * number, a branch code — is never reinterpreted as a date.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function asDate(v: any): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Formatter for the category axis, chosen from the values themselves.
 *
 * Everything is read and rendered in UTC. These are calendar dates the database
 * has no timezone for, and formatting them locally moves "1 Aug" to "31 Jul"
 * for any reader west of Greenwich — a month's figures would appear to land in
 * the previous month.
 *
 * Granularity follows the data: a series that is entirely month-starts is a
 * monthly series and reads as "Aug 2026", not "1 Aug".
 */
export function makeCategoryFormat(values: any[]): { short: (v: any) => string; full: (v: any) => string } {
  const dates = values.map(asDate);
  const allDates = dates.length > 0 && dates.every((d) => d !== null);
  if (!allDates) {
    const plain = (v: any) => (v === null || v === undefined ? '—' : String(v));
    return { short: plain, full: plain };
  }

  const ds = dates as Date[];
  const monthly = ds.every((d) => d.getUTCDate() === 1);
  const multiYear = new Set(ds.map((d) => d.getUTCFullYear())).size > 1;

  const shortOpts: Intl.DateTimeFormatOptions = monthly
    ? { month: 'short', year: 'numeric' }
    : multiYear
      ? { day: 'numeric', month: 'short', year: '2-digit' }
      : { day: 'numeric', month: 'short' };

  const shortFmt = new Intl.DateTimeFormat('en-IN', { ...shortOpts, timeZone: 'UTC' });
  const fullFmt = new Intl.DateTimeFormat('en-IN', {
    ...(monthly
      ? { month: 'long', year: 'numeric' }
      : { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
    timeZone: 'UTC',
  });

  const wrap = (f: Intl.DateTimeFormat) => (v: any) => {
    const d = asDate(v);
    return d ? f.format(d) : v === null || v === undefined ? '—' : String(v);
  };
  return { short: wrap(shortFmt), full: wrap(fullFmt) };
}


/**
 * Splits a filename into the part that may be shortened and the part that must
 * not be.
 *
 * Truncating a filename from the right eats the extension, which is the single
 * most useful character group in it: "weekly-bookings-sep2025-aug202…" no longer
 * tells you whether you attached a spreadsheet or a text file. Keeping the
 * extension as its own non-shrinking element means CSS ellipsis lands on the
 * stem instead — "weekly-bookings-sep20….csv".
 *
 * Only a trailing extension of 1-5 characters is split off; a dot inside a name
 * like "2026.08.25-bookings" is left alone rather than treated as one.
 */
export function splitFilename(name: string): { stem: string; ext: string } {
  const m = /^(.*)(\.[A-Za-z0-9]{1,5})$/.exec(name);
  return m ? { stem: m[1], ext: m[2] } : { stem: name, ext: '' };
}

/** Bytes as something a person reads at a glance. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

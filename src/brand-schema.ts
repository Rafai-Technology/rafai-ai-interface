/**
 * What a deployment can call itself, and what it may not get wrong.
 *
 * The one definition of a brand, shared by the app (brand.ts), the Vite build
 * (vite.config.ts) and — mirrored in shell, because the runtime image has no
 * Node — the container entrypoint (brand.sh). Pure on purpose: no DOM, so the
 * build can import it and tools/brand-test.ts can run it under plain Node.
 *
 * WHAT IS BRANDABLE, AND WHAT IS DELIBERATELY NOT
 *
 *   brandable   the AI's name, the company, the tagline, the sidebar logo (and
 *               a dark-theme variant), the tab icon, the accent colour, the
 *               thin bar across the top, and the sidebar background — each
 *               colour with an optional dark-theme variant.
 *
 *   not         page surfaces, text greys and borders — they are tuned for
 *               contrast in both themes, and a customer's colour as the page
 *               background is how an app becomes unreadable. The sidebar is
 *               the one exception, and its text is derived from its colour
 *               rather than chosen. And never the chart palette: it is
 *               validated for colour-blind separation as a set (theme.ts), and
 *               swapping one hue for a brand colour can make two series
 *               indistinguishable. Brand goes on the chrome, never on the data.
 */

export interface Brand {
  /** The AI's name: tab title, top bar, the empty-state prompt, sidebar, PDF footer. */
  name: string;
  /** Who ships it. The logo's alt text. */
  company: string;
  /** The small line under the logo. */
  tagline: string;
  /** Sidebar logo, drawn at its own aspect ratio. Null draws the name as a wordmark. */
  logo: string | null;
  /** The sidebar logo on the dark theme, for a logo that vanishes on dark. */
  logoDark: string | null;
  /** Browser tab icon. Square reads best. */
  favicon: string;
  /** Buttons, focus rings, the question bubble — and TEXT on links and tabs, so it must be readable. */
  accent: string;
  /** The accent on the dark theme. */
  accentDark: string;
  /** The rule across the top of the workspace. Decoration only, so any colour works. */
  bar: string;
  /** Sidebar background. Null keeps the neutral sidebar. Its text colour is derived, never set. */
  sidebar: string | null;
  /** Sidebar background on the dark theme. */
  sidebarDark: string | null;
}

export const DEFAULT_BRAND: Brand = {
  name: 'Rafai AI',
  company: 'Rafai Technologies',
  tagline: 'Analytics',
  logo: '/rafai-logo.png',
  logoDark: null,
  favicon: '/rafai-logo.png',
  accent: '#1f799a',
  accentDark: '#1f799a',
  bar: '#66c3e4',
  sidebar: null,
  sidebarDark: null,
};

/** The environment variable behind each field. This table IS the white-label surface. */
export const BRAND_ENV: Record<keyof Brand, string> = {
  name: 'BRAND_NAME',
  company: 'BRAND_COMPANY',
  tagline: 'BRAND_TAGLINE',
  logo: 'BRAND_LOGO_URL',
  logoDark: 'BRAND_LOGO_DARK_URL',
  favicon: 'BRAND_FAVICON_URL',
  accent: 'BRAND_ACCENT',
  accentDark: 'BRAND_ACCENT_DARK',
  bar: 'BRAND_BAR',
  sidebar: 'BRAND_SIDEBAR',
  sidebarDark: 'BRAND_SIDEBAR_DARK',
};

type Kind = 'text' | 'url' | 'colour';

const KIND: Record<keyof Brand, Kind> = {
  name: 'text', company: 'text', tagline: 'text',
  logo: 'url', logoDark: 'url', favicon: 'url',
  accent: 'colour', accentDark: 'colour', bar: 'colour', sidebar: 'colour', sidebarDark: 'colour',
};

export const BRAND_FIELDS = Object.keys(KIND) as (keyof Brand)[];

/**
 * The fields that say WHO this is. Set any one of them and the deployment is a
 * customer's, so the others must fall back to the customer's own values or to
 * neutral ones — never to Rafai's. A white-label build that shows the vendor's
 * name or logo because someone forgot one variable is a leak, not a default.
 */
const IDENTITY: (keyof Brand)[] = ['name', 'company', 'logo', 'logoDark', 'favicon'];

/* ------------------------------------------------------------------ rules
   Every rule in this block is mirrored in brand.sh, and they are ASCII-only on
   purpose: shell character classes change meaning with the locale, and a rule
   that agrees with the shell only on some machines is not a rule.
   tools/brand-test.ts runs both on the same inputs and fails if they differ. */

/* Built from character codes rather than written as escapes. Written as a
   regex escape, a tool once "helpfully" decoded it and put raw NUL bytes into
   this source file, and git then treated the whole file as binary. */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`, 'g');

/* With or without the '#'. A .env file read by Vite treats an unquoted '#' as
   the start of a comment, so BRAND_ACCENT=#6d28d9 silently arrives EMPTY there;
   `6d28d9` works in every writer. */
const HEX = /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/* Printable ASCII only, and never a quote or a backslash. The backslash is the
   important one: "/\evil.com/x.png" looks like a path on this site, and every
   browser resolves it to https://evil.com/x.png. */
const URL_BAD_CHAR = /[^!-~]|["\\]/;
/* https, a same-origin /path (not the protocol-relative //host), or an inline
   image. Never http: on an https site the browser blocks it as mixed content. */
const URL_SHAPE = /^(?:https:\/\/.+|\/[^/].*|data:image\/[a-zA-Z0-9.+-]+[;,].*)$/;

/** WCAG AA for normal text. The accent colours links, tabs and pinned items. */
const TEXT_CONTRAST = 4.5;
/** The worst-case grounds an accent is read against, per theme. */
const LIGHT_GROUND = '#f9f9f7';
const DARK_GROUND = '#1a1a19';
/** The near-black the app uses for text; the dark choice for text on a colour. */
const INK = '#0b0b0b';

const spaces = (s: string) => s.replace(/^ +| +$/g, '');

/**
 * Control characters out, spaces trimmed, then ONE surrounding pair of quotes
 * removed — `docker run --env-file` passes quotes through literally, so a
 * value copied from a .env file arrives as "Acme" with the quotes.
 */
function clean(raw: string): string {
  return spaces(spaces(raw.replace(CONTROL, '')).replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'));
}

function check(kind: Kind, value: string): { ok: true; value: string } | { ok: false; why: string } {
  if (kind === 'colour') {
    return HEX.test(value)
      ? { ok: true, value: `#${value.replace(/^#/, '')}` }
      : { ok: false, why: 'not a hex colour (write it as 6d28d9 or #6d28d9)' };
  }
  if (kind === 'url') {
    return !URL_BAD_CHAR.test(value) && URL_SHAPE.test(value)
      ? { ok: true, value }
      : { ok: false, why: 'use https://..., a /path on this site, or a data:image URL' };
  }
  return { ok: true, value };
}

/** A value echoed into a message — a data: URL can be kilobytes long. */
function shown(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

/** By code points, so a Devanagari name is never cut through the middle of a letter. */
function clip(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

/**
 * BRAND_* variables to the values /brand.js should carry. Unset and blank are
 * both "not set". Invalid values are reported, not carried: the build turns
 * them into an error, the container into a warning.
 */
export function readBrandEnv(env: Record<string, string | undefined>): {
  values: Partial<Record<keyof Brand, string>>;
  errors: string[];
} {
  const values: Partial<Record<keyof Brand, string>> = {};
  const errors: string[] = [];
  for (const field of BRAND_FIELDS) {
    const name = BRAND_ENV[field];
    const raw = env[name];
    if (raw === undefined) continue;
    const value = clean(raw);
    if (!value) continue;
    const result = check(KIND[field], value);
    if (result.ok) values[field] = result.value;
    else errors.push(`${name}="${shown(value)}": ${result.why}`);
  }
  return { values, errors };
}

/** The exact file /brand.js carries. brand.sh writes the same shape in shell. */
export function brandScript(values: Partial<Record<keyof Brand, string>>): string {
  return `window.__BRAND__ = ${JSON.stringify(values)};` + String.fromCharCode(10);
}

/* ---------------------------------------------------------------- colour */

function rgb(hex: string): [number, number, number] {
  let h = hex.replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The text colour that reads on a given background.
 *
 * The stylesheet used to write `color: #fff` on every accent background. That
 * is right for Rafai's teal and wrong for most brands: a yellow or sky-blue
 * accent turned the question bubble and the primary button into white on
 * pastel. This picks whichever of white or near-black has more contrast.
 */
export function onColour(background: string): string {
  return contrast(background, '#ffffff') >= contrast(background, INK) ? '#ffffff' : INK;
}

/**
 * A tab icon made from the name, for a customer that set a name but neither an
 * icon nor a logo — far better than leaving the vendor's icon on their tab.
 */
export function monogramIcon(name: string, background: string): string {
  const letter = (Array.from(name.trim())[0] ?? '?').toUpperCase();
  const safe = letter.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    `<rect width="64" height="64" rx="14" fill="${background}"/>` +
    '<text x="32" y="44" text-anchor="middle" font-size="36" font-weight="700" ' +
    `font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" fill="${onColour(background)}">${safe}</text>` +
    '</svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/* --------------------------------------------------------------- resolve */

/**
 * Whatever /brand.js carried — possibly nothing, possibly hand-edited — to a
 * complete, safe brand. Never throws: a broken brand file must still render an
 * app, so every bad value is reported and replaced.
 */
export function resolveBrand(raw: unknown): { brand: Brand; problems: string[] } {
  const problems: string[] = [];
  const given: Partial<Record<keyof Brand, string>> = {};
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  for (const field of BRAND_FIELDS) {
    const value = source[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      problems.push(`${BRAND_ENV[field]} ignored: expected text, got ${typeof value}`);
      continue;
    }
    const cleaned = clean(value);
    if (!cleaned) continue;
    const result = check(KIND[field], cleaned);
    if (result.ok) given[field] = result.value;
    else problems.push(`${BRAND_ENV[field]}="${shown(cleaned)}" ignored: ${result.why}`);
  }

  const customised = IDENTITY.some((field) => given[field] !== undefined);
  const name = clip(given.name ?? (customised ? given.company ?? 'AI Assistant' : DEFAULT_BRAND.name), 60);

  /* One colour set is a brand; the rest follow it rather than staying teal. */
  const accent = given.accent ?? given.accentDark ?? DEFAULT_BRAND.accent;
  const accentDark = given.accentDark ?? given.accent ?? DEFAULT_BRAND.accentDark;
  const sidebar = given.sidebar ?? given.sidebarDark ?? null;

  const brand: Brand = {
    name,
    company: clip(given.company ?? (customised ? name : DEFAULT_BRAND.company), 80),
    tagline: clip(given.tagline ?? DEFAULT_BRAND.tagline, 40),
    logo: given.logo ?? (customised ? null : DEFAULT_BRAND.logo),
    logoDark: given.logoDark ?? null,
    favicon: given.favicon ?? given.logo ?? (customised ? monogramIcon(name, accent) : DEFAULT_BRAND.favicon),
    accent,
    accentDark,
    bar: given.bar ?? given.accent ?? given.accentDark ?? DEFAULT_BRAND.bar,
    sidebar,
    sidebarDark: given.sidebarDark ?? sidebar,
  };

  /* Only the customer's own colours are checked. The shipped default is what
     it is (its dark accent is 3.5:1); nagging about it on every page load
     would teach people to ignore the console line that matters. */
  if (given.accent || given.accentDark) {
    const light = contrast(brand.accent, LIGHT_GROUND);
    if (light < TEXT_CONTRAST) {
      problems.push(`accent ${brand.accent} is ${light.toFixed(1)}:1 on the light theme; links and tabs use it as text, which needs ${TEXT_CONTRAST}:1 — use a darker shade`);
    }
    const dark = contrast(brand.accentDark, DARK_GROUND);
    if (dark < TEXT_CONTRAST) {
      problems.push(`accent ${brand.accentDark} is ${dark.toFixed(1)}:1 on the dark theme — set BRAND_ACCENT_DARK to a lighter shade`);
    }
  }
  const readableOn = (bg: string) => Math.max(contrast(bg, '#ffffff'), contrast(bg, INK));
  if (given.sidebar && readableOn(given.sidebar) < TEXT_CONTRAST) {
    problems.push(`BRAND_SIDEBAR ${given.sidebar}: neither white nor black text reaches ${TEXT_CONTRAST}:1 on it — pick a lighter or darker shade`);
  }
  if (given.sidebarDark && readableOn(given.sidebarDark) < TEXT_CONTRAST) {
    problems.push(`BRAND_SIDEBAR_DARK ${given.sidebarDark}: neither white nor black text reaches ${TEXT_CONTRAST}:1 on it`);
  }

  return { brand, problems };
}

/**
 * The brand, resolved once and applied to the page.
 *
 * /brand.js is loaded before the app and sets window.__BRAND__. Three things
 * write it, and nothing else in the app knows or cares which:
 *
 *   npm run dev     the Vite plugin serves it live from BRAND_* in .env
 *   npm run build   the Vite plugin writes it into dist/ (Vercel, Netlify, S3)
 *   docker run      brand.sh rewrites it from the container's environment
 *
 * See brand-schema.ts for what can be branded, and why the rest cannot.
 */
import { onColour, resolveBrand, type Brand } from './brand-schema';

declare global {
  interface Window {
    /** Set by /brand.js. Untrusted: resolveBrand validates every field. */
    __BRAND__?: unknown;
  }
}

const resolved = resolveBrand(window.__BRAND__);
for (const problem of resolved.problems) console.warn(`[brand] ${problem}`);

export const BRAND: Brand = resolved.brand;

function headLink(rel: string): HTMLLinkElement {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement('link');
    el.rel = rel;
    document.head.appendChild(el);
  }
  return el;
}

function headMeta(name: string): HTMLMetaElement {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.name = name;
    document.head.appendChild(el);
  }
  return el;
}

const SIDEBAR_PROPS = ['--brand-sidebar', '--brand-sidebar-ink', '--brand-sidebar-dark', '--brand-sidebar-ink-dark'];

/**
 * Colours go in as custom properties on <html>, which styles.css reads as
 * `var(--brand-accent, <shipped teal>)` inside each theme block. Setting
 * --accent-deep directly would not work: an inline style on the root beats the
 * dark theme's selector, and the dark accent could never differ from the light.
 *
 * Called before React renders, so the first painted button is already in the
 * customer's colour.
 */
export function applyBrand(brand: Brand = BRAND): void {
  const root = document.documentElement;
  const css = root.style;
  css.setProperty('--brand-accent', brand.accent);
  css.setProperty('--brand-accent-dark', brand.accentDark);
  css.setProperty('--brand-on-accent', onColour(brand.accent));
  css.setProperty('--brand-on-accent-dark', onColour(brand.accentDark));
  css.setProperty('--brand-bar', brand.bar);

  /* The sidebar is opt-in: only an explicit colour re-scopes its tokens. */
  if (brand.sidebar) {
    const dark = brand.sidebarDark ?? brand.sidebar;
    css.setProperty('--brand-sidebar', brand.sidebar);
    css.setProperty('--brand-sidebar-ink', onColour(brand.sidebar));
    css.setProperty('--brand-sidebar-dark', dark);
    css.setProperty('--brand-sidebar-ink-dark', onColour(dark));
    root.dataset.brandSidebar = '';
  } else {
    for (const prop of SIDEBAR_PROPS) css.removeProperty(prop);
    delete root.dataset.brandSidebar;
  }

  document.title = brand.name;
  const icon = headLink('icon');
  icon.href = brand.favicon;
  /* An inline SVG icon is ignored by some browsers without its type. */
  if (brand.favicon.startsWith('data:image/svg')) icon.type = 'image/svg+xml';
  else icon.removeAttribute('type');
  /* Mobile browsers colour their own address bar with this. */
  headMeta('theme-color').content = brand.bar;
}

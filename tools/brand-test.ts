/**
 * The white-label rules, proven without a browser.
 *
 *   node --experimental-strip-types tools/brand-test.ts
 *   BRAND_TEST_DOCKER=1 node --experimental-strip-types tools/brand-test.ts
 *
 * What it holds:
 *   - no customer deployment ever shows Rafai's name, logo or icon
 *   - a value that could reach another origin or inject anything is refused
 *   - brand.sh (the container) and readBrandEnv (the build) produce the SAME
 *     brand from the same environment — they cannot share code, so this is the
 *     only thing keeping them honest
 *   - the container keeps the built brand when nothing is set, and never
 *     refuses to start over a brand problem
 *
 * The second form reruns the shell parity cases under real busybox in
 * nginx:alpine, which is what actually runs in production.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRAND_ENV, BRAND_FIELDS, DEFAULT_BRAND, HEAD_END, HEAD_START, brandHead, brandScript, contrast, onColour,
  readBrandEnv, resolveBrand,
} from '../src/brand-schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'brand.sh');
const NL = String.fromCharCode(10);

let pass = 0;
let fail = 0;
const results: string[] = [];
function it(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    results.push(`  ok    ${name}`);
  } catch (e) {
    fail++;
    const message = (e as Error).message.split(NL).join(`${NL}          `);
    results.push(`  FAIL  ${name}${NL}          ${message}`);
  }
}

const leaksRafai = (value: unknown) => /rafai/i.test(JSON.stringify(value));

/* ------------------------------------------------------------ no leaks */

it('the default brand is Rafai, with nothing to complain about', () => {
  const { brand, problems } = resolveBrand(undefined);
  assert.equal(brand.name, 'Rafai AI');
  assert.equal(brand.logo, DEFAULT_BRAND.logo);
  assert.equal(brand.sidebar, null);
  assert.deepEqual(problems, []);
});

for (const [field, value] of [
  ['name', 'Acme'], ['company', 'Acme Ltd'], ['logo', '/acme.png'], ['logoDark', '/acme-dark.png'], ['favicon', '/acme.ico'],
] as const) {
  it(`setting only ${field} leaves no trace of Rafai`, () => {
    const { brand } = resolveBrand({ [field]: value });
    assert.ok(!leaksRafai(brand), JSON.stringify(brand));
  });
}

it('a name alone: the company follows it, the logo becomes a wordmark, the icon a monogram', () => {
  const { brand } = resolveBrand({ name: 'Acme Assist' });
  assert.equal(brand.company, 'Acme Assist');
  assert.equal(brand.logo, null);
  assert.ok(brand.favicon.startsWith('data:image/svg+xml,'), brand.favicon);
});

it('a company alone names the AI after it', () => {
  assert.equal(resolveBrand({ company: 'Acme Ltd' }).brand.name, 'Acme Ltd');
});

it('a logo alone: a neutral name, and the logo becomes the tab icon', () => {
  const { brand } = resolveBrand({ logo: '/acme.png' });
  assert.equal(brand.name, 'AI Assistant');
  assert.equal(brand.favicon, '/acme.png');
});

it('colours alone do not make it a customer deployment', () => {
  assert.equal(resolveBrand({ accent: '#6d28d9' }).brand.name, 'Rafai AI');
});

/* ------------------------------------------------------------- colours */

it('one accent colours the dark theme and the bar too', () => {
  const { brand } = resolveBrand({ accent: '#6d28d9' });
  assert.equal(brand.accentDark, '#6d28d9');
  assert.equal(brand.bar, '#6d28d9');
});

it('a dark accent alone is not left beside a teal light theme', () => {
  const { brand } = resolveBrand({ accentDark: '#a78bfa' });
  assert.equal(brand.accent, '#a78bfa');
  assert.equal(brand.bar, '#a78bfa');
});

it('the sidebar is opt-in, and one colour covers both themes', () => {
  assert.equal(resolveBrand({ accent: '#6d28d9' }).brand.sidebar, null);
  assert.equal(resolveBrand({ sidebar: '#1e1b4b' }).brand.sidebarDark, '#1e1b4b');
  assert.equal(resolveBrand({ sidebarDark: '#0f0d2e' }).brand.sidebar, '#0f0d2e');
});

it('a colour is accepted with or without its #, and carried with it', () => {
  assert.equal(readBrandEnv({ BRAND_ACCENT: '6d28d9' }).values.accent, '#6d28d9');
  assert.equal(readBrandEnv({ BRAND_BAR: '#fc0' }).values.bar, '#fc0');
  assert.equal(resolveBrand({ accent: '6d28d9' }).brand.accent, '#6d28d9');
});

it('quotes copied from a .env file into docker --env-file are removed', () => {
  const { values } = readBrandEnv({ BRAND_NAME: '"Acme"', BRAND_ACCENT: "'#6d28d9'" });
  assert.equal(values.name, 'Acme');
  assert.equal(values.accent, '#6d28d9');
});

for (const bad of ['#12345678', '#1234', 'red', 'rgb(0,0,0)', '#ggg', '1f799a0']) {
  it(`refuses the colour ${JSON.stringify(bad)}`, () => {
    const { values, errors } = readBrandEnv({ BRAND_ACCENT: bad });
    assert.equal(values.accent, undefined);
    assert.equal(errors.length, 1);
  });
}

it('contrast is WCAG contrast', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.equal(contrast('#1f799a', '#1a1a19').toFixed(2), '3.53');
});

it('text on a colour is whichever of white or near-black reads', () => {
  assert.equal(onColour('#ffcc00'), '#0b0b0b');
  assert.equal(onColour('#1e1b4b'), '#ffffff');
});

it('an accent too light to read as text is warned about', () => {
  assert.ok(resolveBrand({ accent: '#ffcc00' }).problems.some((p) => p.includes('light theme')));
});

it('a sidebar no text colour can read on is warned about', () => {
  assert.ok(resolveBrand({ sidebar: '#777777' }).problems.some((p) => p.includes('BRAND_SIDEBAR')));
  assert.deepEqual(resolveBrand({ sidebar: '#1e1b4b' }).problems, []);
});

/* ------------------------------------------------------------ security */

for (const bad of [
  '/\\evil.com/x.png', '//evil.com/x.png', 'javascript:alert(1)', 'http://acme.com/x.png',
  'data:text/html,<b>x</b>', 'https://acme.com/a b.png', 'https://acme.com/"x', 'https://acme.com/logo-é.png', 'logo.png',
]) {
  it(`refuses the image URL ${JSON.stringify(bad)}`, () => {
    const { values, errors } = readBrandEnv({ BRAND_LOGO_URL: bad });
    assert.equal(values.logo, undefined);
    assert.equal(errors.length, 1);
    /* …and a hand-edited brand.js carrying it falls back instead. */
    const { brand, problems } = resolveBrand({ logo: bad });
    assert.equal(brand.logo, DEFAULT_BRAND.logo);
    assert.equal(problems.length, 1);
  });
}

for (const good of ['https://cdn.acme.com/logo.svg', '/brand/acme.png', 'data:image/svg+xml,%3Csvg%3E', 'data:image/png;base64,AAAA']) {
  it(`accepts the image URL ${JSON.stringify(good.slice(0, 40))}`, () => {
    assert.equal(readBrandEnv({ BRAND_LOGO_URL: good }).values.logo, good);
  });
}

it('a value of the wrong type in brand.js is reported and ignored', () => {
  const { brand, problems } = resolveBrand({ name: 42, accent: ['#fff'] });
  assert.equal(brand.name, 'Rafai AI');
  assert.equal(problems.length, 2);
});

it('the monogram icon cannot carry markup', () => {
  const svg = decodeURIComponent(resolveBrand({ name: '<b>Acme' }).brand.favicon.slice('data:image/svg+xml,'.length));
  assert.ok(!svg.includes('<b>'), svg);
  assert.ok(svg.includes('&#60;'), svg);
});

it('a long Devanagari name is clipped by letters, not bytes', () => {
  const { brand } = resolveBrand({ name: 'आशा सहायक '.repeat(12) });
  assert.equal(Array.from(brand.name).length, 60);
});

it('brand.sh reads every variable the schema defines', () => {
  const shell = readFileSync(SCRIPT, 'utf8');
  for (const field of BRAND_FIELDS) assert.ok(shell.includes(BRAND_ENV[field]), `${BRAND_ENV[field]} missing from brand.sh`);
});

/* ---------------------------------------------------- shell = TypeScript */

const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const TAB = String.fromCharCode(9);
const NBSP = String.fromCharCode(160);

const PARITY: Record<string, Record<string, string>> = {
  'quote, backslash, $ and %': { BRAND_NAME: 'Ac"me\\ $HOME %s' },
  'a leading -n': { BRAND_NAME: '-n' },
  'edge spaces and tabs': { BRAND_TAGLINE: `  ${TAB}Ops${TAB}  ` },
  'embedded ESC and DEL': { BRAND_COMPANY: `Ac${ESC}me${DEL} Ltd` },
  'Devanagari': { BRAND_NAME: 'आशा सहायक' },
  'emoji': { BRAND_TAGLINE: 'Freight 🚚' },
  'non-breaking spaces are not trimmed by either': { BRAND_NAME: `${NBSP}Acme${NBSP}` },
  'quoted values': { BRAND_ACCENT: '"#6d28d9"', BRAND_NAME: "'Acme'" },
  'hex without # and short hex': { BRAND_ACCENT: '6D28D9', BRAND_BAR: '#fc0' },
  'blanks are unset': { BRAND_NAME: '   ', BRAND_ACCENT: '' },
  'every field': {
    BRAND_NAME: 'Acme Assist', BRAND_COMPANY: 'Acme Logistics', BRAND_TAGLINE: 'Operations',
    BRAND_LOGO_URL: '/brand/logo.svg', BRAND_LOGO_DARK_URL: 'https://cdn.acme.com/logo-white.svg',
    BRAND_FAVICON_URL: 'data:image/png;base64,AAAA', BRAND_ACCENT: '6d28d9', BRAND_ACCENT_DARK: '#a78bfa',
    BRAND_BAR: 'f59e0b', BRAND_SIDEBAR: '1e1b4b', BRAND_SIDEBAR_DARK: '#0f0d2e',
  },
  'invalid values dropped, valid kept': { BRAND_LOGO_URL: '/\\evil.com/x', BRAND_ACCENT: 'nope', BRAND_NAME: 'Acme' },
  'a non-ASCII URL': { BRAND_LOGO_URL: 'https://acme.com/logo-é.png' },
  'a URL with a space': { BRAND_FAVICON_URL: 'https://acme.com/a b.png' },
  'http is refused': { BRAND_LOGO_URL: 'http://acme.com/logo.png' },
};

type Run = { status: number | null; stdout: string; stderr: string };

function runLocal(env: Record<string, string>, path = '-'): Run {
  const r = spawnSync('sh', [SCRIPT], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', BRAND_JS_PATH: path, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function runBusybox(env: Record<string, string>): Run {
  const r = spawnSync('docker', [
    'run', '--rm', '-e', 'BRAND_JS_PATH', ...Object.keys(env).flatMap((k) => ['-e', k]),
    '-v', `${SCRIPT}:/brand.sh:ro`, 'nginx:alpine', 'sh', '/brand.sh',
  ], { env: { ...process.env, BRAND_JS_PATH: '-', ...env }, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function payload(stdout: string): unknown {
  const line = stdout.split(NL).find((l) => l.startsWith('window.__BRAND__ = '));
  assert.ok(line, `no brand payload in: ${JSON.stringify(stdout)}`);
  assert.ok(line.endsWith(';'), line);
  return JSON.parse(line.slice('window.__BRAND__ = '.length, -1));
}

function parity(label: string, run: (env: Record<string, string>) => Run): void {
  for (const [name, env] of Object.entries(PARITY)) {
    it(`${label}: ${name}`, () => {
      const r = run(env);
      assert.equal(r.status, 0, r.stderr);
      const expected = readBrandEnv(env);
      assert.deepEqual(payload(r.stdout), expected.values);
      const warned = r.stderr.split(NL).filter((l) => l.includes('ignoring')).length;
      assert.equal(warned, expected.errors.length, `shell warned ${warned}, schema reported ${expected.errors.length}: ${r.stderr}`);
    });
  }
}

parity('shell matches the build', runLocal);

it('the build writes the same file shape the shell does', () => {
  const env = PARITY['every field'];
  assert.equal(brandScript(readBrandEnv(env).values).trim(), runLocal(env).stdout.trim());
});

/* ------------------------------------------------------------ link preview */

const HEAD_CASES: Record<string, Record<string, string>> = {
  ...PARITY,
  'share image and site': {
    BRAND_NAME: 'Acme', BRAND_LOGO_URL: '/brands/acme/logo.png',
    BRAND_SHARE_IMAGE_URL: '/brands/acme/share.png', BRAND_SITE_URL: 'https://ai.acme.com/',
  },
  'markup in a name is escaped': { BRAND_NAME: '<b>"A&B"</b>', BRAND_TAGLINE: "Ops'" },
  'an inline icon is no preview image': { BRAND_NAME: 'Acme', BRAND_FAVICON_URL: 'data:image/png;base64,AAAA' },
  'a bad share image and site are dropped': { BRAND_NAME: 'Acme', BRAND_SHARE_IMAGE_URL: 'data:image/png;base64,AA', BRAND_SITE_URL: 'http://acme.com' },
};

for (const [name, env] of Object.entries(HEAD_CASES)) {
  it(`preview tags, shell matches the build: ${name}`, () => {
    const r = runLocal({ ...env, BRAND_HTML_PATH: '-' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, brandHead(env).html);
  });
}

it('a customer link preview never shows Rafai', () => {
  for (const env of [{ BRAND_NAME: 'Acme' }, { BRAND_COMPANY: 'Acme' }, { BRAND_LOGO_URL: '/brands/acme/logo.png' }]) {
    assert.ok(!/rafai/i.test(brandHead(env).html), JSON.stringify(env));
  }
});

it('the preview image is absolute when a site is given, and escaped', () => {
  const { html } = brandHead(HEAD_CASES['share image and site']);
  assert.match(html, /og:image" content="https:\/\/ai\.acme\.com\/brands\/acme\/share\.png"/);
  assert.match(brandHead(HEAD_CASES['markup in a name is escaped']).html, /<title>&lt;b&gt;&quot;A&amp;B&quot;/);
});

/* ------------------------------------------------------------ container */

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'brand-test-'));
}

it('nothing set at runtime: the built brand.js is left exactly as it was', () => {
  const dir = scratch();
  const file = join(dir, 'brand.js');
  writeFileSync(file, 'BUILT');
  const r = runLocal({ BRAND_NAME: '', BRAND_ACCENT: '   ' }, file);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(file, 'utf8'), 'BUILT');
  assert.match(r.stdout, /keeping/);
  rmSync(dir, { recursive: true, force: true });
});

it('something set at runtime: the brand is replaced, not merged', () => {
  const dir = scratch();
  const file = join(dir, 'brand.js');
  writeFileSync(file, 'window.__BRAND__ = {"accent":"#123456"};');
  const r = runLocal({ BRAND_NAME: 'Acme' }, file);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(payload(readFileSync(file, 'utf8')), { name: 'Acme' });
  rmSync(dir, { recursive: true, force: true });
});

it('a bad value never stops the container', () => {
  const dir = scratch();
  const file = join(dir, 'brand.js');
  const r = runLocal({ BRAND_NAME: 'Acme', BRAND_ACCENT: 'purple' }, file);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /ignoring BRAND_ACCENT/);
  assert.deepEqual(payload(readFileSync(file, 'utf8')), { name: 'Acme' });
  rmSync(dir, { recursive: true, force: true });
});

it('an unwritable web root is warned about, and the container still starts', () => {
  if (process.getuid?.() === 0) return;           // root can write anywhere; nothing to prove
  const dir = scratch();
  chmodSync(dir, 0o555);
  const r = runLocal({ BRAND_NAME: 'Acme' }, join(dir, 'brand.js'));
  chmodSync(dir, 0o755);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /not writable/);
  rmSync(dir, { recursive: true, force: true });
});

it('images under /brands/ are copied in — only the ones the brand names', () => {
  const dir = scratch();
  const assets = join(dir, 'brands-src');
  for (const name of ['acme/logo.png', 'acme/icon.png', 'other/logo.png']) {
    mkdirSync(join(assets, dirname(name)), { recursive: true });
    writeFileSync(join(assets, name), name);
  }
  const web = join(dir, 'html');
  mkdirSync(join(web, 'brands', 'stale'), { recursive: true });
  const r = runLocal({
    BRAND_NAME: 'Acme',
    BRAND_LOGO_URL: '/brands/acme/logo.png',
    BRAND_LOGO_DARK_URL: '/brands/acme/missing.png',
    BRAND_FAVICON_URL: '/brands/acme/../other/logo.png',
    BRAND_ASSETS_DIR: assets,
  }, join(web, 'brand.js'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(web, 'brands', 'acme', 'logo.png'), 'utf8'), 'acme/logo.png');
  assert.equal(existsSync(join(web, 'brands', 'acme', 'icon.png')), false);
  assert.equal(existsSync(join(web, 'brands', 'other')), false);
  assert.equal(existsSync(join(web, 'brands', 'stale')), false);
  assert.match(r.stderr, /no acme\/missing\.png/);
  assert.match(r.stderr, /not copying \/brands\/acme\/\.\.\/other\/logo\.png/);
  rmSync(dir, { recursive: true, force: true });
});

it('index.html: the brand block is replaced, the rest of the page kept', () => {
  const dir = scratch();
  const page = ['<html><head>', HEAD_START, '<title>Built</title>', HEAD_END, '<script src="/x.js"></script>', '</head></html>', ''].join(NL);
  writeFileSync(join(dir, 'index.html'), page);
  const env = { BRAND_NAME: 'Acme', BRAND_SHARE_IMAGE_URL: '/brands/acme/share.png' };
  const r = runLocal(env, join(dir, 'brand.js'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, 'index.html'), 'utf8'),
    ['<html><head>', HEAD_START, brandHead(env).html, HEAD_END, '<script src="/x.js"></script>', '</head></html>', ''].join(NL));
  rmSync(dir, { recursive: true, force: true });
});

if (process.env.BRAND_TEST_DOCKER === '1') parity('busybox matches the build', runBusybox);

console.log(`${NL}  white-label${NL}${results.join(NL)}${NL}${NL}  ${pass} passed, ${fail} failed` +
  (process.env.BRAND_TEST_DOCKER === '1' ? '' : '  (busybox parity skipped: set BRAND_TEST_DOCKER=1)') + NL);
process.exit(fail ? 1 : 0);

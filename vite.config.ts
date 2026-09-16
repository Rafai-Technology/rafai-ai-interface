import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { BRAND_ENV, HEAD_END, HEAD_START, brandHead, brandScript, readBrandEnv, resolveBrand } from './src/brand-schema';

/**
 * White-label: /brand.js from the BRAND_* variables. See src/brand-schema.ts
 * for what they are and README "White-label" for how to use them.
 *
 * Dev serves the file live. A build emits it into dist/ ALWAYS, even as an
 * empty brand: on a static host a missing /brand.js falls through the SPA
 * rewrite and comes back as index.html, which the browser then tries to run as
 * JavaScript. In Docker, brand.sh rewrites the emitted file at container start.
 *
 * A bad value stops the build (and the dev server) here, naming the variable —
 * the build is the one moment someone is watching. The container only warns.
 *
 * An image given as /brands/<name>/<file> is that file in this repo's brands/
 * folder. The build copies in only the files the brand names — never the whole
 * folder — so a customer's site does not also serve every other customer's
 * logo. (Dev serves the project root, so there every brand's files resolve.)
 */
/* The same shape brand.sh accepts before it copies a file. No segment may start
   with a dot, so there is no way out of brands/. */
const BRAND_ASSET = /^\/brands\/[a-z0-9-]+\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;

function brandPlugin(): Plugin {
  let script = brandScript({});
  let head = brandHead({}).html;
  let base = '/';
  let assets = new Map<string, string>();
  return {
    name: 'rafai-brand',
    configResolved(config) {
      base = config.base;
      const env = loadEnv(config.mode, config.envDir || config.root, 'BRAND_');
      const { values } = readBrandEnv(env);
      /* Crawlers want an absolute og:image. Vercel exposes the production
         domain at build time, so a Vercel deploy needs no BRAND_SITE_URL. */
      const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
      const headEnv = { ...env, BRAND_SITE_URL: env.BRAND_SITE_URL ?? (vercel ? `https://${vercel}` : undefined) };
      const built = brandHead(headEnv);
      const errors = built.errors;
      assets = new Map();
      const images: [string, string | null | undefined][] = [
        ...(['logo', 'logoDark', 'favicon'] as const).map((f) => [BRAND_ENV[f], values[f]] as [string, string | undefined]),
        ['BRAND_SHARE_IMAGE_URL', built.shareImage],
      ];
      for (const [name, url] of images) {
        if (!url?.startsWith('/brands/')) continue;
        const file = join(config.root, url);
        if (!BRAND_ASSET.test(url)) errors.push(`${name}="${url}": expected /brands/<name>/<file>`);
        else if (!existsSync(file)) errors.push(`${name}="${url}": there is no ${file}`);
        else assets.set(url, file);
      }
      if (errors.length) {
        throw new Error(`Invalid brand configuration:\n  ${errors.join('\n  ')}`);
      }
      const { problems } = resolveBrand(values);
      for (const problem of problems) config.logger.warn(`[brand] ${problem}`);
      script = brandScript(values);
      head = built.html;
    },
    configureServer(server) {
      /* Registered directly rather than returned, so it runs before Vite's own
         middleware and /brand.js is never mistaken for a missing module. */
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== `${base}brand.js`) return next();
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(script);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'brand.js', source: script });
      for (const [url, file] of assets) {
        this.emitFile({ type: 'asset', fileName: url.slice(1), source: readFileSync(file) });
      }
    },
    transformIndexHtml(html) {
      return {
        /* Title, icon and link-preview tags in the HTML itself: WhatsApp,
           Slack and Teams never run the page's scripts. Replaced with a
           function so a "$&" in a brand name is text, not a pattern. */
        html: html.replace(
          new RegExp(`${HEAD_START}[\\s\\S]*?${HEAD_END}`),
          () => `${HEAD_START}\n${head}\n${HEAD_END}`,
        ),
        /* At the end of <head>: both must run after <title> and <link rel=icon>
           exist, and before the app — brand-boot.js corrects them from the
           brand, including one written at container start. */
        tags: [
          { tag: 'script', attrs: { src: `${base}brand.js` }, injectTo: 'head' },
          { tag: 'script', attrs: { src: `${base}brand-boot.js` }, injectTo: 'head' },
        ],
      };
    },
  };
}

/**
 * The dev proxy exists so the browser stays on one origin during development:
 * the JWT never crosses an origin boundary and there is no CORS story to
 * explain. It is only used by `vite dev`.
 *
 * A built bundle talks to whatever VITE_API_BASE_URL was set at BUILD time —
 * Vite inlines it, so this is not a runtime setting. Deploying the same bundle
 * against a different API means rebuilding, or serving it behind a reverse
 * proxy that maps /api to the service (in which case leave the variable unset).
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react(), brandPlugin()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: env.VITE_DEV_API_TARGET ?? 'http://localhost:3000',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ''),
        },
      },
    },
    build: { outDir: 'dist', sourcemap: false },
  };
});

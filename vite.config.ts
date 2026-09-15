import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { brandScript, readBrandEnv, resolveBrand } from './src/brand-schema';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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
 */
function brandPlugin(): Plugin {
  let script = brandScript({});
  let title = resolveBrand({}).brand.name;
  let base = '/';
  return {
    name: 'rafai-brand',
    configResolved(config) {
      base = config.base;
      const env = loadEnv(config.mode, config.envDir || config.root, 'BRAND_');
      const { values, errors } = readBrandEnv(env);
      if (errors.length) {
        throw new Error(`Invalid brand configuration:\n  ${errors.join('\n  ')}`);
      }
      const { brand, problems } = resolveBrand(values);
      for (const problem of problems) config.logger.warn(`[brand] ${problem}`);
      script = brandScript(values);
      title = brand.name;
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
    },
    transformIndexHtml(html) {
      return {
        /* The name in the HTML itself, for link previews in Slack or Teams,
           which never run the page's scripts. Replaced with a function so a
           "$&" in a brand name is text, not a replacement pattern. */
        html: html.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)}</title>`),
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

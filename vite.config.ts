import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

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
    plugins: [react()],
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

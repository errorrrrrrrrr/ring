/* The composer's build (spec 14): React 19 + TypeScript strict, Vite into
 * app-dist/ (gitignored), served by the Express server at /app. Dev
 * dependencies only. The CSP stays self-only: one module script and one
 * stylesheet, both same-origin files, no inline script, no CDN. */
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'app',
  base: '/app/',
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir: '../app-dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    target: 'es2022',
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
});

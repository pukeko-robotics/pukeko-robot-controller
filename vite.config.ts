import { fileURLToPath, URL } from 'node:url'

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// OPS-8: read the worktree-root `.env` (this config sits at the repo root, so
// process.cwd() === where `.env` lives). Done at module top-level (not via the
// `({ mode }) => …` callback form) so `vitest.config.ts` can still `mergeConfig`
// this as a plain object. Only the base `.env` matters here (no `.env.[mode]`
// files exist), so the mode arg is immaterial. `WEB_PORT` shifts the dev server;
// unset falls back to today's 5173. `AGUI_URL` is deliberately sourced from
// `process.env` (not the file) so plain `dev` stays in config.json mode and only
// the explicit `dev:ag-ui` script (which loads `.env`) flips to AG-UI mode.
const env = loadEnv(process.env.NODE_ENV || 'development', process.cwd(), '')

export default defineConfig({
  plugins: [vue()],
  define: {
    __AGUI_URL__: JSON.stringify(process.env.AGUI_URL || ''),
  },
  build: {
    outDir: fileURLToPath(new URL('dist/client', import.meta.url)),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Local-source aliases for @galvanized-pukeko/vue-ui — useful when iterating
      // on the vue-ui source in `_refs/galvanized-pukeko/` without re-publishing.
      // Uncomment together with the matching entry in `tsconfig.app.json` `paths`.
      // '@galvanized-pukeko/vue-ui/style.css': fileURLToPath(
      //   new URL(
      //     '_refs/galvanized-pukeko/packages/galvanized-pukeko-vue-ui/src/assets/global.css',
      //     import.meta.url,
      //   ),
      // ),
      // '@galvanized-pukeko/vue-ui': fileURLToPath(
      //   new URL(
      //     '_refs/galvanized-pukeko/packages/galvanized-pukeko-vue-ui/src',
      //     import.meta.url,
      //   ),
      // ),
    },
  },
  server: {
    port: Number(env.WEB_PORT) || 5173,
  },
})

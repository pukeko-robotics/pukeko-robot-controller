import { fileURLToPath, URL } from 'node:url'
import { defineConfig, configDefaults } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./packages/web-client/src', import.meta.url)),
      '@galvanized-pukeko/vue-ui/style.css': fileURLToPath(
        new URL(
          '_refs/galvanized-pukeko-ai-ui/packages/galvanized-pukeko-vue-ui/src/assets/global.css',
          import.meta.url,
        ),
      ),
      '@galvanized-pukeko/vue-ui': fileURLToPath(
        new URL(
          '_refs/galvanized-pukeko-ai-ui/packages/galvanized-pukeko-vue-ui/src',
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '_refs/**'],
    environment: 'jsdom',
    globals: true,
    testTimeout: 10000,
  },
})

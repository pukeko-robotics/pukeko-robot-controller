import { mergeConfig, defineConfig, configDefaults } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['tests/**/*.test.ts'],
      exclude: [...configDefaults.exclude, '_refs/**'],
      environment: 'jsdom',
      globals: true,
      testTimeout: 10000,
    },
  }),
)

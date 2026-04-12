import { mergeConfig, defineConfig, configDefaults } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['tests/**/*.test.ts'],
      environment: 'jsdom',
      exclude: [...configDefaults.exclude],
      globals: true,
      testTimeout: 10000,
    },
  }),
)

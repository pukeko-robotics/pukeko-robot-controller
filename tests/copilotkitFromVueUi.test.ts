import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * PLAT-58: vue-ui owns the CopilotKit stack. The robot takes CopilotKit and AG-UI
 * only through `@galvanized-pukeko/vue-ui`, so the browser app holds one copy of
 * each. A pin of its own here is how the app ends up with two `@ag-ui/client`
 * copies, whose agents CopilotKit does not recognise; the unit suite cannot see
 * that split at runtime, so these specs pin its preconditions instead.
 */

const root = `${import.meta.dirname}/..`
const manifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const lockfile = readFileSync(`${root}/pnpm-lock.yaml`, 'utf8')

/** The distinct versions of `name` the lockfile resolves, from its `packages:` keys. */
function lockedVersions(name: string): string[] {
  const key = new RegExp(`^  '?${name.replace('/', '\\/')}@(\\d[^(':]*)`, 'gm')
  return [...new Set([...lockfile.matchAll(key)].map((m) => m[1]))]
}

describe('CopilotKit comes from vue-ui (PLAT-58)', () => {
  it('declares no @copilotkit/* or @ag-ui/* package of its own', () => {
    const own = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(
      (name) => name.startsWith('@copilotkit/') || name.startsWith('@ag-ui/'),
    )
    expect(own).toEqual([])
  })

  it('resolves exactly one @copilotkit/vue and one @ag-ui/client', () => {
    expect(lockedVersions('@copilotkit/vue')).toHaveLength(1)
    expect(lockedVersions('@ag-ui/client')).toHaveLength(1)
  })
})

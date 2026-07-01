import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../server/loadConfig.js'

let tmpDir: string
const ENV_KEYS = [
  'PUKEKO_PROFILE',
  'LLM_PROVIDER',
  'OLLAMA_MODEL',
  'OLLAMA_BASE_URL',
  'ANTHROPIC_MODEL',
  'ROBOT_HOST',
  'ROBOT_PRESET',
  'PUKEKO_DUMP_DIR',
  'PUKEKO_VERBOSE',
] as const

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pukeko-cfg-'))
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('loadConfig', () => {
  it('falls back to gemma4 when no config file is present', async () => {
    const resolved = await loadConfig(tmpDir)
    expect(resolved.configPath).toBeNull()
    expect(resolved.profile.llm.provider).toBe('ollama')
    expect(resolved.profile.llm.model).toBe('gemma4:31b')
  })

  it('reads pukeko.config.json', async () => {
    writeFileSync(
      join(tmpDir, 'pukeko.config.json'),
      JSON.stringify({
        defaultProfile: 'a',
        profiles: {
          a: { llm: { provider: 'ollama', model: 'a-model' } },
          b: { llm: { provider: 'anthropic', model: 'b-model' } },
        },
      })
    )
    const resolved = await loadConfig(tmpDir)
    expect(resolved.profileName).toBe('a')
    expect(resolved.profile.llm.model).toBe('a-model')
  })

  it('selects profile via PUKEKO_PROFILE', async () => {
    writeFileSync(
      join(tmpDir, 'pukeko.config.json'),
      JSON.stringify({
        defaultProfile: 'a',
        profiles: {
          a: { llm: { provider: 'ollama', model: 'a-model' } },
          b: { llm: { provider: 'anthropic', model: 'b-model' } },
        },
      })
    )
    process.env.PUKEKO_PROFILE = 'b'
    const resolved = await loadConfig(tmpDir)
    expect(resolved.profileName).toBe('b')
    expect(resolved.profile.llm.provider).toBe('anthropic')
  })

  it('applies env-var overrides on top of profile', async () => {
    writeFileSync(
      join(tmpDir, 'pukeko.config.json'),
      JSON.stringify({
        defaultProfile: 'a',
        profiles: { a: { llm: { provider: 'ollama', model: 'a-model' } } },
      })
    )
    process.env.OLLAMA_MODEL = 'gemma-override'
    process.env.ROBOT_HOST = '10.0.0.1'
    const resolved = await loadConfig(tmpDir)
    expect(resolved.profile.llm.model).toBe('gemma-override')
    expect(resolved.profile.robot?.host).toBe('10.0.0.1')
  })

  it('applies ROBOT_PRESET as an env override (RC-1)', async () => {
    writeFileSync(
      join(tmpDir, 'pukeko.config.json'),
      JSON.stringify({
        defaultProfile: 'a',
        profiles: { a: { llm: { provider: 'ollama', model: 'a-model' } } },
      })
    )
    process.env.ROBOT_PRESET = 'ACEBOTT-QD021'
    const resolved = await loadConfig(tmpDir)
    expect(resolved.profile.robot?.preset).toBe('ACEBOTT-QD021')
  })

  it('PUKEKO_VERBOSE=1 flips observability on with defaults', async () => {
    writeFileSync(
      join(tmpDir, 'pukeko.config.json'),
      JSON.stringify({
        defaultProfile: 'a',
        profiles: { a: { llm: { provider: 'ollama', model: 'm' } } },
      })
    )
    process.env.PUKEKO_VERBOSE = '1'
    process.env.PUKEKO_DUMP_DIR = './my-logs'
    const resolved = await loadConfig(tmpDir)
    expect(resolved.profile.observability?.verbose).toBe(true)
    expect(resolved.profile.observability?.dumpDir).toBe('./my-logs')
    expect(resolved.profile.observability?.dumpImages).toBe(true)
  })

  it('warns and falls back when PUKEKO_PROFILE is unknown', async () => {
    writeFileSync(
      join(tmpDir, 'pukeko.config.json'),
      JSON.stringify({
        defaultProfile: 'a',
        profiles: { a: { llm: { provider: 'ollama', model: 'm' } } },
      })
    )
    process.env.PUKEKO_PROFILE = 'does-not-exist'
    const resolved = await loadConfig(tmpDir)
    expect(resolved.profileName).toBe('a')
  })

  it('rejects config without a profiles object', async () => {
    writeFileSync(
      join(tmpDir, 'pukeko.config.json'),
      JSON.stringify({ defaultProfile: 'a' })
    )
    await expect(loadConfig(tmpDir)).rejects.toThrow(/missing 'profiles'/)
  })
})

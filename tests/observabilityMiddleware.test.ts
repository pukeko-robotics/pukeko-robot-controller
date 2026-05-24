import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import {
  createObservabilityMiddleware,
  __extractImagesForTest,
  __turnCountersForTest,
} from '../server/observabilityMiddleware.js'

let baseDir: string

function getHook(hook: unknown): (state: unknown, runtime: unknown) => unknown {
  if (typeof hook === 'function') return hook as (state: unknown, runtime: unknown) => unknown
  if (hook && typeof hook === 'object' && 'hook' in hook && typeof (hook as { hook: unknown }).hook === 'function') {
    return (hook as { hook: (state: unknown, runtime: unknown) => unknown }).hook
  }
  throw new Error('Hook not callable')
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'pukeko-obs-'))
  __turnCountersForTest.clear()
})

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

// Stable round-trippable bytes (PNG header + a few bytes). We don't need a
// real image — just a known byte pattern that survives base64 decode/encode.
const SAMPLE_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
])
const ONE_PIXEL_JPEG_B64 = SAMPLE_BYTES.toString('base64')

describe('observabilityMiddleware', () => {
  it('extracts image bytes from ollama-style image_url blocks', () => {
    const url = `data:image/jpeg;base64,${ONE_PIXEL_JPEG_B64}`
    const msg = new HumanMessage({
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: url },
      ],
    })
    const images = __extractImagesForTest([msg])
    expect(images.length).toBe(1)
    expect(images[0].mimeType).toBe('image/jpeg')
    expect(images[0].bytes.toString('base64')).toBe(ONE_PIXEL_JPEG_B64)
  })

  it('extracts image bytes from anthropic-style image source_type blocks', () => {
    const msg = new HumanMessage({
      content: [
        {
          type: 'image',
          source_type: 'base64',
          mime_type: 'image/jpeg',
          data: ONE_PIXEL_JPEG_B64,
        },
      ],
    })
    const images = __extractImagesForTest([msg])
    expect(images.length).toBe(1)
    expect(images[0].mimeType).toBe('image/jpeg')
  })

  it('writes per-turn folder structure on beforeModel', async () => {
    const mw = createObservabilityMiddleware({ dumpDir: baseDir, dumpImages: true })
    const before = getHook((mw as { beforeModel: unknown }).beforeModel)
    const state = {
      messages: [
        new HumanMessage('move the robot'),
        new HumanMessage({
          content: [
            { type: 'text', text: 'Before/After' },
            {
              type: 'image_url',
              image_url: `data:image/jpeg;base64,${ONE_PIXEL_JPEG_B64}`,
            },
          ],
        }),
      ],
    }
    const runtime: Record<string, unknown> = { configurable: { thread_id: 'thread-A' } }
    await before(state, runtime)

    const threadDir = join(baseDir, 'thread-A')
    const turns = readdirSync(threadDir)
    expect(turns.length).toBe(1)
    expect(turns[0]).toMatch(/^turn-001-/)

    const turnDir = join(threadDir, turns[0])
    const turnEntries = readdirSync(turnDir)
    expect(turnEntries).toContain('messages.json')
    expect(turnEntries).toContain('meta.json')
    expect(turnEntries).toContain('images')

    const images = readdirSync(join(turnDir, 'images'))
    expect(images.length).toBe(1)
    expect(images[0]).toMatch(/\.jpg$/)

    const imgBytes = readFileSync(join(turnDir, 'images', images[0])).toString('base64')
    expect(imgBytes).toBe(ONE_PIXEL_JPEG_B64)

    const meta = JSON.parse(readFileSync(join(turnDir, 'meta.json'), 'utf8'))
    expect(meta.threadId).toBe('thread-A')
    expect(meta.turn).toBe(1)
    expect(meta.imageCount).toBe(1)
    expect(meta.messageCount).toBe(2)
  })

  it('increments turn counter across calls per thread', async () => {
    const mw = createObservabilityMiddleware({ dumpDir: baseDir, dumpImages: false })
    const before = getHook((mw as { beforeModel: unknown }).beforeModel)
    const state = { messages: [new HumanMessage('hi')] }
    const runtime: Record<string, unknown> = { configurable: { thread_id: 'T' } }
    await before(state, runtime)
    await before(state, runtime)
    await before(state, runtime)
    const turns = readdirSync(join(baseDir, 'T'))
    expect(turns.length).toBe(3)
    expect(turns.some((t) => t.startsWith('turn-001-'))).toBe(true)
    expect(turns.some((t) => t.startsWith('turn-002-'))).toBe(true)
    expect(turns.some((t) => t.startsWith('turn-003-'))).toBe(true)
  })

  it('writes response.json on afterModel using same folder', async () => {
    const mw = createObservabilityMiddleware({ dumpDir: baseDir, dumpImages: false })
    const before = getHook((mw as { beforeModel: unknown }).beforeModel)
    const after = getHook((mw as { afterModel: unknown }).afterModel)
    const runtime: Record<string, unknown> = { configurable: { thread_id: 'T2' } }
    await before({ messages: [new HumanMessage('hi')] }, runtime)
    await after(
      {
        messages: [new HumanMessage('hi'), new AIMessage('done')],
      },
      runtime
    )
    const turns = readdirSync(join(baseDir, 'T2'))
    const turnDir = join(baseDir, 'T2', turns[0])
    expect(readdirSync(turnDir)).toContain('response.json')
    const resp = JSON.parse(readFileSync(join(turnDir, 'response.json'), 'utf8'))
    expect(resp.content).toBe('done')
  })

  it('fails open if the dump directory is unwritable', async () => {
    // Null-byte path is rejected synchronously by Node's fs layer.
    const mw = createObservabilityMiddleware({ dumpDir: 'invalid\0path', dumpImages: false })
    const before = getHook((mw as { beforeModel: unknown }).beforeModel)
    const runtime: Record<string, unknown> = { configurable: { thread_id: 'denied' } }
    await expect(
      before({ messages: [new HumanMessage('hi')] }, runtime)
    ).resolves.toBeUndefined()
  })

  it('uses __default__ when no thread_id is provided', async () => {
    const mw = createObservabilityMiddleware({ dumpDir: baseDir, dumpImages: false })
    const before = getHook((mw as { beforeModel: unknown }).beforeModel)
    await before({ messages: [new HumanMessage('hi')] }, undefined)
    expect(statSync(join(baseDir, '__default__')).isDirectory()).toBe(true)
  })
})

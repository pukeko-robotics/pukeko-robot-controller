import { describe, it, expect } from 'vitest'
import { createToolAnnouncementTracker } from '../src/lib/toolAnnouncementTracker.js'

// PLAT-13: the Tool Belt's server-fulfilled-tool signal on the headless
// engine — the SSE announcement window (TOOL_CALL_START → the next lifecycle
// event), reproduced from the agent's event subscription instead of the
// retired bespoke `runState`/`statusText` singletons. These tests assert the
// exact window semantics the bespoke fallback had (see the chatService state
// transitions quoted in src/lib/toolAnnouncementTracker.ts).

function start(name: string) {
  return { event: { toolCallName: name } }
}

describe('createToolAnnouncementTracker', () => {
  it('starts with no announced tool', () => {
    const t = createToolAnnouncementTracker()
    expect(t.announcedToolName.value).toBeNull()
  })

  it('opens the window on TOOL_CALL_START with that tool name', () => {
    const t = createToolAnnouncementTracker()
    t.subscriber.onToolCallStartEvent(start('read_status'))
    expect(t.announcedToolName.value).toBe('read_status')
  })

  it('closes the window on TOOL_CALL_RESULT (bespoke: → waiting)', () => {
    const t = createToolAnnouncementTracker()
    t.subscriber.onToolCallStartEvent(start('read_distance'))
    t.subscriber.onToolCallResultEvent()
    expect(t.announcedToolName.value).toBeNull()
  })

  it('closes the window when the model starts talking again (bespoke: → streaming)', () => {
    const t = createToolAnnouncementTracker()
    t.subscriber.onToolCallStartEvent(start('stop'))
    t.subscriber.onTextMessageStartEvent()
    expect(t.announcedToolName.value).toBeNull()
  })

  it('closes the window when the model starts REASONING (bespoke: → "Thinking…", review M2)', () => {
    // Bespoke chatService also left 'running-tool' on REASONING_MESSAGE_START
    // — matters on reasoning-emitting models (e.g. the Ollama/gemma path),
    // where the pulse would otherwise outlive its bespoke window.
    const t = createToolAnnouncementTracker()
    t.subscriber.onToolCallStartEvent(start('read_distance'))
    t.subscriber.onReasoningMessageStartEvent()
    expect(t.announcedToolName.value).toBeNull()
  })

  it('closes the window on run finished / failed / finalized (bespoke: → idle)', () => {
    for (const end of ['onRunFinishedEvent', 'onRunFailed', 'onRunFinalized'] as const) {
      const t = createToolAnnouncementTracker()
      t.subscriber.onToolCallStartEvent(start('finish_task'))
      t.subscriber[end]()
      expect(t.announcedToolName.value, end).toBeNull()
    }
  })

  it('a later TOOL_CALL_START overwrites the announced name', () => {
    const t = createToolAnnouncementTracker()
    t.subscriber.onToolCallStartEvent(start('read_status'))
    t.subscriber.onToolCallStartEvent(start('read_distance'))
    expect(t.announcedToolName.value).toBe('read_distance')
  })

  it('the ref is reactive state usable as a prop source (same object across events)', () => {
    const t = createToolAnnouncementTracker()
    const theRef = t.announcedToolName
    t.subscriber.onToolCallStartEvent(start('stop'))
    expect(theRef.value).toBe('stop')
    t.subscriber.onToolCallResultEvent()
    expect(theRef.value).toBeNull()
  })
})

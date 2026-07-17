import { describe, it, expect } from 'vitest'
import { createToolFiringTracker } from '../src/lib/toolFiringTracker.js'

// Regression test for the pulse-timing bug found in manual browser testing
// during PLAT-22 (see task-1-report.md "Tool Belt pulse mechanism"): the
// first cut watched vue-ui's `runState`/`statusText` for every belt item,
// which looked reasonable but never actually overlapped a client-fulfilled
// tool's real execution — `chatService`'s run loop calls the handler AFTER
// the SSE stream's RUN_FINISHED event, by which point `runState` had already
// flipped back to 'idle'. The fix was to wrap the REAL handler call instead
// (createToolFiringTracker). This test proves the "active" window covers the
// actual async handler execution — not the moment it's *called*, not just
// some synchronous flag-flip — so a future refactor that reintroduces a
// "set-then-immediately-clear" version of this bug fails here first.
//
// A controllable (deferred) promise stands in for the real handler (the
// robot HTTP fetch + webcam capture/compose in RobotSession) so the test can
// assert the tracker's state *while the handler is still in flight*, which
// is exactly the window the original bug missed.
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createToolFiringTracker', () => {
  it('starts with no tool firing', () => {
    const { firingToolName } = createToolFiringTracker()
    expect(firingToolName.value).toBeNull()
  })

  it('is set to the tool name for the full span of the handler call — not just when invoked, and not cleared until it settles (the regression case)', async () => {
    const { firingToolName, wrap } = createToolFiringTracker()
    const handlerCall = deferred<string>()
    const wrapped = wrap('move_forward', () => handlerCall.promise)

    expect(firingToolName.value).toBeNull()

    const resultPromise = wrapped({ steps: 1 })

    // The handler has been called but not yet resolved — this is the exact
    // window the runState/statusText signal missed (it would already be back
    // to 'idle' here for a client-fulfilled tool). The fix must show it active.
    await Promise.resolve() // let the wrap()'s async function body start running
    expect(firingToolName.value).toBe('move_forward')

    handlerCall.resolve('{"ok":true}')
    const result = await resultPromise

    expect(result).toBe('{"ok":true}')
    expect(firingToolName.value).toBeNull()
  })

  it('clears even when the handler rejects', async () => {
    const { firingToolName, wrap } = createToolFiringTracker()
    const handlerCall = deferred<string>()
    const wrapped = wrap('turn_left', () => handlerCall.promise)

    const resultPromise = wrapped({ steps: 1 })
    await Promise.resolve()
    expect(firingToolName.value).toBe('turn_left')

    handlerCall.reject(new Error('robot unreachable'))
    await expect(resultPromise).rejects.toThrow('robot unreachable')
    expect(firingToolName.value).toBeNull()
  })

  it('does not report a different tool as firing while one tool is in flight', async () => {
    const { firingToolName, wrap } = createToolFiringTracker()
    const forwardCall = deferred<string>()
    const wrappedForward = wrap('move_forward', () => forwardCall.promise)

    void wrappedForward({})
    await Promise.resolve()
    expect(firingToolName.value).toBe('move_forward')
    expect(firingToolName.value).not.toBe('turn_left')

    forwardCall.resolve('done')
    await Promise.resolve()
    await Promise.resolve()
  })

  it('is reusable across sequential calls to different tools (real usage: the client tool loop runs one at a time)', async () => {
    const { firingToolName, wrap } = createToolFiringTracker()
    const forwardCall = deferred<string>()
    const turnCall = deferred<string>()
    const wrappedForward = wrap('move_forward', () => forwardCall.promise)
    const wrappedTurn = wrap('turn_left', () => turnCall.promise)

    const forwardResult = wrappedForward({})
    await Promise.resolve()
    expect(firingToolName.value).toBe('move_forward')
    forwardCall.resolve('forward done')
    await forwardResult
    expect(firingToolName.value).toBeNull()

    const turnResult = wrappedTurn({})
    await Promise.resolve()
    expect(firingToolName.value).toBe('turn_left')
    turnCall.resolve('turn done')
    await turnResult
    expect(firingToolName.value).toBeNull()
  })

  it("does not clear a DIFFERENT tool's still-in-flight name (defensive slot guard: the finally only clears its own name)", async () => {
    const { firingToolName, wrap } = createToolFiringTracker()
    const forwardCall = deferred<string>()
    const wrappedForward = wrap('move_forward', () => forwardCall.promise)

    // Simulate a stale/overlapping settle: manually claim the slot for a
    // different tool while `wrappedForward`'s own handler is in flight —
    // the `finally` guard (`if (firingToolName.value === name)`) must leave
    // an unrelated name alone rather than blindly nulling it out.
    const resultPromise = wrappedForward({})
    await Promise.resolve()
    expect(firingToolName.value).toBe('move_forward')
    firingToolName.value = 'turn_left'

    forwardCall.resolve('done')
    await resultPromise

    expect(firingToolName.value).toBe('turn_left')
  })
})

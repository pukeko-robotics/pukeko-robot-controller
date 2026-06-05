// Shared, deterministic per-thread loop state for the robot agent.
//
// This is *process* memory keyed by LangGraph thread_id — it lives outside the
// LLM-written summary so the facts below are immune to summary drift. Both
// pruning middlewares (motion-summarization and context-pruner) read it when
// they rewrite history, so whichever one is active keeps the same durable record.
//
// It carries four things:
//   1. A recent-motion log (last N motions, newest pending) so the model never
//      physically repeats a move it already attempted after a prune.
//   2. A "has a real tool run yet" flag, used to gate `finish_task` so the model
//      can't give up (failed / need_input) before doing any actual work.
//   3. The last confirmed calibration line the model reported — the single most
//      expensive fact to lose on a prune (forces a costly re-calibration).
//   4. A count of motions elided past the cap, surfaced so the model can tell the
//      recent-motion log is truncated.

import type { BaseMessage } from '@langchain/core/messages';
import { MOTION_TOOL_NAMES, FINISH_TOOL_NAME } from './robotToolNames.js';

const MOTION_NAMES: ReadonlySet<string> = new Set(MOTION_TOOL_NAMES);

export interface MotionEntry {
  label: string;
  pending: boolean;
}

const motionLogByThread = new Map<string, MotionEntry[]>();
const elidedByThread = new Map<string, number>();
const realToolByThread = new Set<string>();
const calibrationByThread = new Map<string, string>();
const MAX_MOTION_LOG = 5;

interface MaybeToolCall {
  name?: unknown;
  args?: unknown;
}

interface MaybeBlock {
  type?: string;
  text?: string;
}

// Human-readable label for the motion a message just issued, e.g.
// "turn_right (steps=3)". Returns null when the message has no motion call.
export function motionLabel(msg: unknown): string | null {
  if (!msg || typeof msg !== 'object') return null;
  const tcs = (msg as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(tcs)) return null;
  for (const tc of tcs as MaybeToolCall[]) {
    if (typeof tc?.name === 'string' && MOTION_NAMES.has(tc.name)) {
      const rawSteps = (tc.args as { steps?: unknown } | undefined)?.steps;
      const n =
        typeof rawSteps === 'number' && Number.isFinite(rawSteps) && rawSteps >= 1
          ? Math.floor(rawSteps)
          : 1;
      return n > 1 ? `${tc.name} (steps=${n})` : tc.name;
    }
  }
  return null;
}

export function isMotionToolCall(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false;
  // Be permissive: state.messages entries may be serialized plain objects
  // depending on how LangGraph round-trips them between hooks.
  const tcs = (msg as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(tcs)) return false;
  return tcs.some(
    (tc: MaybeToolCall) => typeof tc?.name === 'string' && MOTION_NAMES.has(tc.name)
  );
}

function extractText(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as MaybeBlock[])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join(' ')
    .trim();
}

// Record a freshly-issued motion: the previously pending one is now resolved
// (its result was observed last turn), and this one becomes the new pending.
// Anything that falls off the front of the capped window bumps the elided count.
export function recordMotion(threadId: string, label: string): void {
  const log = motionLogByThread.get(threadId) ?? [];
  for (const e of log) e.pending = false;
  log.push({ label, pending: true });
  while (log.length > MAX_MOTION_LOG) {
    log.shift();
    elidedByThread.set(threadId, (elidedByThread.get(threadId) ?? 0) + 1);
  }
  motionLogByThread.set(threadId, log);
}

export function formatMotionLog(threadId: string): string {
  const log = motionLogByThread.get(threadId);
  if (!log || log.length === 0) return '';
  const elided = elidedByThread.get(threadId) ?? 0;
  const header =
    elided > 0
      ? `Recent motions (newest last; ${elided} earlier motion${elided === 1 ? '' : 's'} elided):`
      : 'Recent motions (newest last):';
  const lines = log.map(
    (e) =>
      `- ${e.label}${e.pending ? ' (pending — its result is the latest Before/After frame below)' : ''}`
  );
  return `${header}\n${lines.join('\n')}`;
}

// Give-up gate (see finish_task): true once any non-terminal tool has run on
// this thread.
export function markRealTool(threadId: string): void {
  realToolByThread.add(threadId);
}

export function hasRunRealTool(threadId: string): boolean {
  return realToolByThread.has(threadId);
}

// The model reports calibration as a one-liner starting "Calibration:" (see
// system-prompt.md). Pin the latest one so it survives a prune.
const CALIBRATION_RE = /^[ \t>*-]*calibration\s*:\s*(.+)$/im;

export function recordCalibration(threadId: string, text: string): void {
  const m = text.match(CALIBRATION_RE);
  if (m) calibrationByThread.set(threadId, m[1].trim());
}

export function getCalibration(threadId: string): string | undefined {
  return calibrationByThread.get(threadId);
}

// The pinned-state block appended to a summary by both pruning middlewares:
// the durable calibration line (if any) plus the deterministic recent-motion
// log. Empty string when there's nothing to pin yet.
export function formatPinnedState(threadId: string): string {
  const parts: string[] = [];
  const calibration = calibrationByThread.get(threadId);
  if (calibration) parts.push(`Calibration (pinned): ${calibration}`);
  const motions = formatMotionLog(threadId);
  if (motions) parts.push(motions);
  return parts.join('\n\n');
}

// One-stop bookkeeping for a just-produced assistant message: records a motion
// (if any), flips the give-up gate when a real (non-terminal) tool was called,
// and pins a calibration line if the message reported one. Idempotent per call;
// call exactly once per assistant turn from a middleware's afterModel.
export function observeAssistantMessage(threadId: string, msg: unknown): void {
  if (!msg || typeof msg !== 'object') return;
  const tcs = (msg as { tool_calls?: unknown }).tool_calls;
  if (Array.isArray(tcs)) {
    let real = false;
    for (const tc of tcs as MaybeToolCall[]) {
      if (typeof tc?.name !== 'string') continue;
      if (tc.name !== FINISH_TOOL_NAME) real = true;
    }
    if (real) markRealTool(threadId);
    const label = motionLabel(msg);
    if (label) recordMotion(threadId, label);
  }
  const text = extractText((msg as BaseMessage).content);
  if (text) recordCalibration(threadId, text);
}

// Exposed for tests; do not call from app code.
export const __motionLogForTest = motionLogByThread;
export function __resetMotionLogForTest(): void {
  motionLogByThread.clear();
  elidedByThread.clear();
  realToolByThread.clear();
  calibrationByThread.clear();
}

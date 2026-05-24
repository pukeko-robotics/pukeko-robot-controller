import { createMiddleware } from 'langchain';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';

export interface ObservabilityOptions {
  dumpDir: string;
  dumpImages?: boolean;
}

// Per-thread turn counter so we can name folders `turn-001-…`, `turn-002-…`
// without colliding across concurrent threads.
const turnCounters = new Map<string, number>();
// thread_id → most-recent turn folder. Stored module-side because the runtime
// object handed to hooks is frozen.
const lastTurnDir = new Map<string, string>();

interface MaybeBlock {
  type?: string;
  text?: string;
  image_url?: string | { url?: string };
  mime_type?: string;
  data?: string;
  source?: { type?: string; media_type?: string; data?: string };
  source_type?: string;
}

interface ExtractedImage {
  mimeType: string;
  bytes: Buffer;
  origin: { messageIndex: number; blockIndex: number };
}

function extOf(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'jpg';
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.*)$/.exec(url);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function extractImages(messages: BaseMessage[]): ExtractedImage[] {
  const out: ExtractedImage[] = [];
  messages.forEach((msg, mIdx) => {
    if (!Array.isArray(msg.content)) return;
    const blocks = msg.content as MaybeBlock[];
    blocks.forEach((b, bIdx) => {
      if (!b || typeof b !== 'object') return;
      // Ollama-shape: { type:'image_url', image_url:'data:...;base64,...' } or { image_url:{url:'data:...'} }
      if (b.type === 'image_url') {
        const url =
          typeof b.image_url === 'string' ? b.image_url : b.image_url?.url;
        if (!url) return;
        const parsed = parseDataUrl(url);
        if (!parsed) return;
        out.push({
          mimeType: parsed.mimeType,
          bytes: Buffer.from(parsed.data, 'base64'),
          origin: { messageIndex: mIdx, blockIndex: bIdx },
        });
        return;
      }
      // LangChain standard / Anthropic-shape:
      // { type:'image', source_type:'base64', mime_type, data }
      // or { type:'image', source: { type:'base64', media_type, data } }
      if (b.type === 'image') {
        if (b.source_type === 'base64' && b.mime_type && b.data) {
          out.push({
            mimeType: b.mime_type,
            bytes: Buffer.from(b.data, 'base64'),
            origin: { messageIndex: mIdx, blockIndex: bIdx },
          });
          return;
        }
        if (b.source?.type === 'base64' && b.source.media_type && b.source.data) {
          out.push({
            mimeType: b.source.media_type,
            bytes: Buffer.from(b.source.data, 'base64'),
            origin: { messageIndex: mIdx, blockIndex: bIdx },
          });
          return;
        }
      }
    });
  });
  return out;
}

function summarizeMessages(messages: BaseMessage[]): unknown[] {
  // Stringify in a stable, human-readable shape. Replace base64 bytes with a
  // pointer to the dumped image file so the JSON file stays grep-friendly.
  return messages.map((msg, mIdx) => {
    const base = {
      type: msg.getType?.() ?? msg.constructor?.name,
      name: msg.name,
      id: (msg as { id?: string }).id,
      tool_call_id: (msg as { tool_call_id?: string }).tool_call_id,
      tool_calls: (msg as { tool_calls?: unknown }).tool_calls,
    } as Record<string, unknown>;
    if (typeof msg.content === 'string') {
      base.content = msg.content;
      return base;
    }
    if (!Array.isArray(msg.content)) {
      base.content = msg.content;
      return base;
    }
    const blocks = (msg.content as MaybeBlock[]).map((b, bIdx) => {
      if (!b || typeof b !== 'object') return b;
      if (b.type === 'image_url' || b.type === 'image') {
        return {
          type: b.type,
          mimeType:
            b.mime_type ??
            b.source?.media_type ??
            (typeof b.image_url === 'string'
              ? parseDataUrl(b.image_url)?.mimeType
              : undefined),
          ref: `images/img-${String(mIdx).padStart(3, '0')}-${String(bIdx).padStart(2, '0')}.<ext>`,
        };
      }
      return b;
    });
    base.content = blocks;
    return base;
  });
}

export function createObservabilityMiddleware(opts: ObservabilityOptions) {
  const baseDir = resolve(opts.dumpDir);
  const dumpImages = opts.dumpImages ?? true;

  return createMiddleware({
    name: 'observability',

    beforeModel: async (state, runtime) => {
      try {
        const messages = (state.messages || []) as BaseMessage[];
        const threadId = runtime?.configurable?.thread_id ?? '__default__';
        const turn = (turnCounters.get(threadId) ?? 0) + 1;
        turnCounters.set(threadId, turn);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const turnDir = join(
          baseDir,
          threadId,
          `turn-${String(turn).padStart(3, '0')}-${ts}`
        );
        await mkdir(turnDir, { recursive: true });

        const images = dumpImages ? extractImages(messages) : [];
        if (images.length > 0) {
          const imgDir = join(turnDir, 'images');
          await mkdir(imgDir, { recursive: true });
          for (const img of images) {
            const name = `img-${String(img.origin.messageIndex).padStart(3, '0')}-${String(img.origin.blockIndex).padStart(2, '0')}.${extOf(img.mimeType)}`;
            await writeFile(join(imgDir, name), img.bytes);
          }
        }

        const meta = {
          threadId,
          turn,
          ts,
          messageCount: messages.length,
          imageCount: images.length,
        };
        await writeFile(join(turnDir, 'meta.json'), JSON.stringify(meta, null, 2));
        await writeFile(
          join(turnDir, 'messages.json'),
          JSON.stringify(summarizeMessages(messages), null, 2)
        );

        lastTurnDir.set(threadId, turnDir);
      } catch (err) {
        console.error('[observability] beforeModel dump failed:', err);
      }
      return undefined;
    },

    afterModel: async (state, runtime) => {
      try {
        const messages = (state.messages || []) as BaseMessage[];
        const last = messages[messages.length - 1];
        const threadId = runtime?.configurable?.thread_id ?? '__default__';
        const turnDir = lastTurnDir.get(threadId);
        if (!turnDir || !last) return undefined;
        const response = {
          type: last.getType?.() ?? last.constructor?.name,
          content:
            typeof last.content === 'string'
              ? last.content
              : summarizeMessages([last])[0],
          tool_calls: (last as { tool_calls?: unknown }).tool_calls,
          usage_metadata: (last as { usage_metadata?: unknown }).usage_metadata,
          response_metadata: (last as { response_metadata?: unknown }).response_metadata,
        };
        await writeFile(
          join(turnDir, 'response.json'),
          JSON.stringify(response, null, 2)
        );
      } catch (err) {
        console.error('[observability] afterModel dump failed:', err);
      }
      return undefined;
    },
  });
}

// Exposed for tests.
export const __turnCountersForTest = turnCounters;
export const __extractImagesForTest = extractImages;

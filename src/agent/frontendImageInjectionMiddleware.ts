import { createMiddleware } from 'langchain';
import { ToolMessage, HumanMessage } from '@langchain/core/messages';
import type { MessageContent } from '@langchain/core/messages';

interface ImagePayload {
  mimeType?: string;
  data?: string;
  error?: string;
}

export interface ImageInjectionOptions {
  // ChatOllama only accepts {type:'image_url', image_url: <data-URL>} blocks;
  // ChatAnthropic accepts the LangChain standard {type:'image', source_type, ...}
  // block. Pick the right shape per provider.
  provider: 'ollama' | 'anthropic';
}

export function createFrontendImageInjectionMiddleware(opts: ImageInjectionOptions) {
  return createMiddleware({
    name: 'frontend-image-injection',

    beforeModel: async (state) => {
      const messages = state.messages || [];
      const injected: ImagePayload[] = [];

      for (let i = messages.length - 1; i >= Math.max(0, messages.length - 5); i--) {
        const msg = messages[i];
        if (
          msg instanceof ToolMessage &&
          msg.name === 'capture_image' &&
          typeof msg.content === 'string'
        ) {
          try {
            injected.push(JSON.parse(msg.content) as ImagePayload);
          } catch {
            // Non-JSON tool result — skip injection.
          }
        }
      }

      if (injected.length === 0) return undefined;

      const newMessages = [...messages];
      for (const payload of injected) {
        if (payload.error) {
          newMessages.push(new HumanMessage({ content: `Camera unavailable: ${payload.error}` }));
          continue;
        }
        if (payload.mimeType && payload.data) {
          const block =
            opts.provider === 'ollama'
              ? {
                  type: 'image_url' as const,
                  image_url: `data:${payload.mimeType};base64,${payload.data}`,
                }
              : {
                  type: 'image' as const,
                  source_type: 'base64' as const,
                  mime_type: payload.mimeType,
                  data: payload.data,
                };

          newMessages.push(
            new HumanMessage({
              content: [
                { type: 'text', text: 'Camera frame captured:' },
                block,
              ] as MessageContent,
            })
          );
        }
      }

      return { messages: newMessages };
    },
  });
}

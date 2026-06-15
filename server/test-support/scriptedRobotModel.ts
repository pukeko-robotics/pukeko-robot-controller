// A deterministic, scripted tool-calling chat model for e2e tests — no network,
// no real LLM. It drives the robot agent through a fixed, minimal loop:
//   turn 1: call the `move_forward` client tool (browser fulfils it: robot stub
//           + Before/After webcam capture + compose)
//   turn 2: call `finish_task` (returnDirect → ends the run)
// so the browser exercises the full C-a client-tool + webcam + compose path
// without a real model. @langchain/core ships no tool-calling fake, hence this.
import {
  BaseChatModel,
  type BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';

type ScriptedCall = { name: string; args: Record<string, unknown>; id: string };

// Has the agent already issued a motion tool call in this thread's history?
// Robust to middleware history-rewriting: we look for the move_forward name in
// either AI tool_calls OR a tool result message.
function motionAlreadyCalled(messages: BaseMessage[]): boolean {
  for (const m of messages) {
    const type = m.getType();
    if (type === 'ai') {
      const calls = (m as AIMessage).tool_calls ?? [];
      if (calls.some((c) => c.name === 'move_forward')) return true;
    }
    if (type === 'tool') {
      const name = (m as unknown as { name?: string }).name;
      if (name === 'move_forward') return true;
    }
  }
  return false;
}

function nextScriptedCall(messages: BaseMessage[]): ScriptedCall {
  if (!motionAlreadyCalled(messages)) {
    return { name: 'move_forward', args: { steps: 1 }, id: 'call_move_forward_1' };
  }
  return {
    name: 'finish_task',
    args: { status: 'success', summary: 'Completed one forward cycle (e2e).' },
    id: 'call_finish_task_1',
  };
}

export class ScriptedRobotChatModel extends BaseChatModel {
  constructor(fields?: BaseChatModelParams) {
    super(fields ?? {});
  }

  _llmType(): string {
    return 'scripted-robot';
  }

  // The deep agent calls bindTools to attach the tool set; the script ignores
  // the tools entirely (it emits a fixed sequence), so just return self.
  override bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const call = nextScriptedCall(messages);
    const message = new AIMessage({ content: '', tool_calls: [call] });
    return { generations: [{ text: '', message }] };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const call = nextScriptedCall(messages);
    const message = new AIMessageChunk({
      content: '',
      tool_call_chunks: [
        { name: call.name, args: JSON.stringify(call.args), id: call.id, index: 0 },
      ],
    });
    const chunk = new ChatGenerationChunk({ text: '', message });
    // Pass the chunk to the run manager so langgraph / the AG-UI server surface
    // the streamed tool call as TOOL_CALL_* events (handleLLMNewToken's `fields.chunk`).
    await runManager?.handleLLMNewToken('', undefined, undefined, undefined, undefined, {
      chunk,
    });
    yield chunk;
  }
}

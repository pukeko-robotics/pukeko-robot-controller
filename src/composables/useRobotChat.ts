import { ref } from 'vue'
import { chatService, type ChatCallbacks } from '@galvanized-pukeko/vue-ui'

export interface RobotMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
}

export interface WebcamProvider {
  captureFrame: () => string | null
  isActive: { value: boolean }
}

export function useRobotChat(getWebcam: () => WebcamProvider | null) {
  const messages = ref<RobotMessage[]>([])
  const isStreaming = ref(false)
  const currentAssistantMessage = ref('')

  function createCallbacks(): ChatCallbacks {
    return {
      onTextMessageStart() {
        isStreaming.value = true
        currentAssistantMessage.value = ''
      },
      onTextMessageContent(_id: string, delta: string) {
        currentAssistantMessage.value += delta
        const lastMsg = messages.value[messages.value.length - 1]
        if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.toolName) {
          lastMsg.content = currentAssistantMessage.value
        } else {
          messages.value.push({
            role: 'assistant',
            content: currentAssistantMessage.value,
          })
        }
      },
      onTextMessageEnd() {
        isStreaming.value = false
        currentAssistantMessage.value = ''
      },
      onToolCallStart(_toolCallId: string, toolName: string) {
        messages.value.push({
          role: 'tool',
          content: `Calling ${toolName}...`,
          toolName,
        })

        if (toolName === 'capture_image') {
          handleCaptureImage(_toolCallId)
        }
      },
      onToolCallEnd(_toolCallId: string, toolName: string) {
        const toolMsg = findLastToolMessage(toolName)
        if (toolMsg && toolMsg.content.endsWith('...')) {
          toolMsg.content = `${toolName} completed`
        }
      },
      onError(error: Error) {
        isStreaming.value = false
        messages.value.push({
          role: 'assistant',
          content: `Error: ${error.message}`,
        })
      },
    }
  }

  function findLastToolMessage(toolName: string): RobotMessage | undefined {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      if (messages.value[i].role === 'tool' && messages.value[i].toolName === toolName) {
        return messages.value[i]
      }
    }
    return undefined
  }

  function handleCaptureImage(toolCallId: string) {
    const webcam = getWebcam()
    if (!webcam || !webcam.isActive.value) {
      chatService.submitToolResult(toolCallId, JSON.stringify({ error: 'Camera not available' }))
      return
    }

    const frame = webcam.captureFrame()
    if (frame) {
      chatService.submitToolResult(
        toolCallId,
        JSON.stringify({ image: frame, timestamp: Date.now() }),
      )
    } else {
      chatService.submitToolResult(toolCallId, JSON.stringify({ error: 'Failed to capture frame' }))
    }
  }

  async function sendMessage(text: string) {
    if (!text.trim()) return

    messages.value.push({ role: 'user', content: text })

    const callbacks = createCallbacks()
    await chatService.sendMessage(text, callbacks)
  }

  return {
    messages,
    isStreaming,
    sendMessage,
  }
}

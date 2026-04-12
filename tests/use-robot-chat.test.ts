import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useRobotChat, type WebcamProvider } from '../src/composables/useRobotChat'

// Mock chatService from @galvanized-pukeko/vue-ui
vi.mock('@galvanized-pukeko/vue-ui', () => ({
  chatService: {
    sendMessage: vi.fn(),
    submitToolResult: vi.fn(),
    resetThread: vi.fn(),
    getThreadId: vi.fn(() => 'test-thread'),
  },
}))

import { chatService } from '@galvanized-pukeko/vue-ui'

const mockChatService = vi.mocked(chatService)

function createMockWebcam(active = true, frame = 'data:image/jpeg;base64,abc123'): WebcamProvider {
  return {
    captureFrame: vi.fn(() => (active ? frame : null)),
    isActive: { value: active },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useRobotChat', () => {
  it('should initialize with empty state', () => {
    const { messages, isStreaming } = useRobotChat(() => null)
    expect(messages.value).toEqual([])
    expect(isStreaming.value).toBe(false)
  })

  it('should add user message when sendMessage is called', async () => {
    mockChatService.sendMessage.mockResolvedValue(undefined)

    const { sendMessage, messages } = useRobotChat(() => null)
    await sendMessage('Move forward')

    expect(messages.value[0]).toEqual({
      role: 'user',
      content: 'Move forward',
    })
  })

  it('should call chatService.sendMessage with text and callbacks', async () => {
    mockChatService.sendMessage.mockResolvedValue(undefined)

    const { sendMessage } = useRobotChat(() => null)
    await sendMessage('Turn left')

    expect(mockChatService.sendMessage).toHaveBeenCalledWith('Turn left', expect.any(Object))
  })

  it('should ignore empty messages', async () => {
    const { sendMessage, messages } = useRobotChat(() => null)
    await sendMessage('')
    await sendMessage('   ')

    expect(messages.value).toEqual([])
    expect(mockChatService.sendMessage).not.toHaveBeenCalled()
  })

  it('should handle text message streaming via callbacks', async () => {
    mockChatService.sendMessage.mockImplementation(async (_text, callbacks) => {
      callbacks.onTextMessageStart?.('')
      callbacks.onTextMessageContent?.('msg-1', 'Hello ')
      callbacks.onTextMessageContent?.('msg-1', 'world')
      callbacks.onTextMessageEnd?.('')
    })

    const { sendMessage, messages, isStreaming } = useRobotChat(() => null)
    await sendMessage('Hi')

    // User message + assistant message
    expect(messages.value).toHaveLength(2)
    expect(messages.value[1]).toEqual({
      role: 'assistant',
      content: 'Hello world',
    })
    expect(isStreaming.value).toBe(false)
  })

  it('should handle tool call events in callbacks', async () => {
    mockChatService.sendMessage.mockImplementation(async (_text, callbacks) => {
      callbacks.onToolCallStart?.('tc-1', 'move_forward')
      callbacks.onToolCallEnd?.('tc-1', 'move_forward')
    })

    const { sendMessage, messages } = useRobotChat(() => null)
    await sendMessage('Move')

    // User message + tool message
    expect(messages.value).toHaveLength(2)
    expect(messages.value[1]).toEqual({
      role: 'tool',
      content: 'move_forward completed',
      toolName: 'move_forward',
    })
  })

  it('should handle capture_image tool by calling webcam', async () => {
    const mockWebcam = createMockWebcam()

    mockChatService.sendMessage.mockImplementation(async (_text, callbacks) => {
      callbacks.onToolCallStart?.('tc-capture', 'capture_image')
    })

    const { sendMessage } = useRobotChat(() => mockWebcam)
    await sendMessage('Look at the robot')

    expect(mockWebcam.captureFrame).toHaveBeenCalled()
    expect(mockChatService.submitToolResult).toHaveBeenCalledWith(
      'tc-capture',
      expect.stringContaining('"image"'),
    )
  })

  it('should submit error when webcam is not available for capture', async () => {
    mockChatService.sendMessage.mockImplementation(async (_text, callbacks) => {
      callbacks.onToolCallStart?.('tc-capture', 'capture_image')
    })

    const { sendMessage } = useRobotChat(() => null)
    await sendMessage('Look')

    expect(mockChatService.submitToolResult).toHaveBeenCalledWith(
      'tc-capture',
      expect.stringContaining('Camera not available'),
    )
  })

  it('should submit error when webcam capture fails', async () => {
    const inactiveWebcam = createMockWebcam(false)

    mockChatService.sendMessage.mockImplementation(async (_text, callbacks) => {
      callbacks.onToolCallStart?.('tc-capture', 'capture_image')
    })

    const { sendMessage } = useRobotChat(() => inactiveWebcam)
    await sendMessage('Look')

    expect(mockChatService.submitToolResult).toHaveBeenCalledWith(
      'tc-capture',
      expect.stringContaining('Camera not available'),
    )
  })

  it('should add error message on streaming error', async () => {
    mockChatService.sendMessage.mockImplementation(async (_text, callbacks) => {
      callbacks.onError?.(new Error('Connection lost'))
    })

    const { sendMessage, messages, isStreaming } = useRobotChat(() => null)
    await sendMessage('Hi')

    const errorMsg = messages.value.find((m) => m.content.includes('Connection lost'))
    expect(errorMsg).toBeDefined()
    expect(isStreaming.value).toBe(false)
  })
})

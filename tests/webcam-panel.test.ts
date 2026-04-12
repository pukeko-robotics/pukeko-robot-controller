import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import WebcamPanel from '../src/components/WebcamPanel.vue'

// Mock getUserMedia
const mockGetUserMedia = vi.fn()
const mockTrackStop = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()

  mockGetUserMedia.mockResolvedValue({
    getTracks: () => [{ stop: mockTrackStop }],
  })

  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: mockGetUserMedia },
    writable: true,
    configurable: true,
  })

  // Mock HTMLVideoElement properties
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
    get: () => 640,
    configurable: true,
  })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
    get: () => 480,
    configurable: true,
  })
})

describe('WebcamPanel', () => {
  it('should mount and request camera access', async () => {
    mount(WebcamPanel)
    await nextTick()

    expect(mockGetUserMedia).toHaveBeenCalledWith({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    })
  })

  it('should expose captureFrame method', () => {
    const wrapper = mount(WebcamPanel)
    expect(wrapper.vm.captureFrame).toBeTypeOf('function')
  })

  it('should expose startCamera and stopCamera methods', () => {
    const wrapper = mount(WebcamPanel)
    expect(wrapper.vm.startCamera).toBeTypeOf('function')
    expect(wrapper.vm.stopCamera).toBeTypeOf('function')
  })

  it('should expose isActive ref', () => {
    const wrapper = mount(WebcamPanel)
    expect(wrapper.vm.isActive).toBeDefined()
  })

  it('should display error when camera access fails', async () => {
    mockGetUserMedia.mockRejectedValueOnce(new Error('Permission denied'))

    const wrapper = mount(WebcamPanel)
    await nextTick()
    await nextTick()

    expect(wrapper.find('.webcam-error').exists()).toBe(true)
    expect(wrapper.text()).toContain('Permission denied')
  })

  it('should have a retry button when camera fails', async () => {
    mockGetUserMedia.mockRejectedValueOnce(new Error('Permission denied'))

    const wrapper = mount(WebcamPanel)
    await nextTick()
    await nextTick()

    const retryBtn = wrapper.find('.webcam-error button')
    expect(retryBtn.exists()).toBe(true)
    expect(retryBtn.text()).toBe('Retry')
  })

  it('should stop camera tracks on unmount', async () => {
    const wrapper = mount(WebcamPanel)
    await nextTick()

    wrapper.unmount()
    expect(mockTrackStop).toHaveBeenCalled()
  })

  it('should contain a video element', () => {
    const wrapper = mount(WebcamPanel)
    expect(wrapper.find('video').exists()).toBe(true)
  })

  it('should contain a hidden canvas for frame capture', () => {
    const wrapper = mount(WebcamPanel)
    const canvas = wrapper.find('canvas')
    expect(canvas.exists()).toBe(true)
    expect(canvas.attributes('style')).toContain('display: none')
  })
})

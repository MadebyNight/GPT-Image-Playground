import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import OpenShopWorkspace, {
  createOpenShopHelloRetryController,
  isOpenShopConfigurationRequestCurrent,
  OPEN_SHOP_HELLO_RETRY_INTERVAL_MS,
  shouldSendOpenShopConfiguration,
} from './OpenShopWorkspace'

afterEach(() => {
  vi.useRealTimers()
})

describe('OpenShopWorkspace', () => {
  it('renders a full-page editor workspace with explicit history saving', () => {
    const markup = renderToStaticMarkup(
      <OpenShopWorkspace
        imageId="image-1"
        taskId="task-1"
        sourceDataUrl="data:image/png;base64,AA=="
        onClose={() => undefined}
        editor={<div data-editor-placeholder />}
      />,
    )

    expect(markup).toContain('data-openshop-workspace')
    expect(markup).toContain('data-image-id="image-1"')
    expect(markup).toContain('data-task-id="task-1"')
    expect(markup).toContain('保存到历史')
    expect(markup).toContain('返回画廊')
  })

  it('renders a fullscreen toggle and grants the embedded editor fullscreen permission', () => {
    const markup = renderToStaticMarkup(
      <OpenShopWorkspace
        imageId="image-1"
        taskId="task-1"
        sourceDataUrl="data:image/png;base64,AA=="
        onClose={() => undefined}
      />,
    )

    expect(markup).toContain('data-openshop-fullscreen-toggle')
    expect(markup).toContain('全屏显示')
    expect(markup).toContain('aria-pressed="false"')
    expect(markup).toContain('allow="clipboard-read; clipboard-write; fullscreen"')
    expect(markup).toMatch(/src="[^"]*openshop\/index\.html\?embed=manual"/)
  })

  it('waits for the embedded editor readiness before sending the source image', () => {
    const readyGate = {
      hasFrameWindow: true,
      hasSourceDataUrl: true,
      hasTargetOrigin: true,
      editorReady: true,
      isConfigured: false,
      isConfiguring: false,
    }

    expect(shouldSendOpenShopConfiguration({ ...readyGate, editorReady: false })).toBe(false)
    expect(shouldSendOpenShopConfiguration({ ...readyGate, isConfiguring: true })).toBe(false)
    expect(shouldSendOpenShopConfiguration(readyGate)).toBe(true)
  })

  it('does not let a pre-reload configuration task post into the new editor session', () => {
    const sharedWindowProxy = {} as Window
    const request = {
      currentFrameWindow: sharedWindowProxy,
      requestFrameWindow: sharedWindowProxy,
      editorReady: true,
      currentRequestId: 'configure-current',
      requestId: 'configure-current',
    }

    expect(isOpenShopConfigurationRequestCurrent(request)).toBe(true)
    expect(isOpenShopConfigurationRequestCurrent({
      ...request,
      currentRequestId: 'configure-after-reload',
    })).toBe(false)
    expect(isOpenShopConfigurationRequestCurrent({
      ...request,
      editorReady: false,
    })).toBe(false)
  })

  it('冷启动时按固定间隔重发同一个 hello，收到 ready 后停止', () => {
    vi.useFakeTimers()
    const helloId = 'hello-cold-start'
    const postedIds: string[] = []
    const retry = createOpenShopHelloRetryController(() => postedIds.push(helloId))

    retry.start()
    vi.advanceTimersByTime(OPEN_SHOP_HELLO_RETRY_INTERVAL_MS * 2)

    expect(postedIds).toEqual([helloId, helloId, helloId])
    expect(vi.getTimerCount()).toBe(1)

    retry.stop()
    vi.advanceTimersByTime(OPEN_SHOP_HELLO_RETRY_INTERVAL_MS * 2)

    expect(postedIds).toEqual([helloId, helloId, helloId])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('iframe load/reload 重启 hello 时清理旧 timer，卸载时不遗留 timer', () => {
    vi.useFakeTimers()
    const retryHello = vi.fn()
    const retry = createOpenShopHelloRetryController(retryHello)

    retry.start()
    vi.advanceTimersByTime(OPEN_SHOP_HELLO_RETRY_INTERVAL_MS)
    expect(retryHello).toHaveBeenCalledTimes(2)

    retry.start()
    expect(retryHello).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(OPEN_SHOP_HELLO_RETRY_INTERVAL_MS)
    expect(retryHello).toHaveBeenCalledTimes(4)

    retry.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})

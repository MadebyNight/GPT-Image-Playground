import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import OpenShopWorkspace, {
  isOpenShopConfigurationRequestCurrent,
  shouldSendOpenShopConfiguration,
} from './OpenShopWorkspace'

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
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_PARAMS } from '../types'
import { DEFAULT_SETTINGS } from '../lib/apiProfiles'
import { initializeRuntimeConfig } from '../lib/serverApiConfig'

afterEach(() => {
  initializeRuntimeConfig({ version: 1, serverApi: { enabled: false } })
  vi.doUnmock('../store')
  vi.resetModules()
})

describe('DetailModal runtime configuration boundaries', () => {
  it('keeps historical task details renderable when runtime configuration is invalid', async () => {
    initializeRuntimeConfig({ version: 1, serverApi: { enabled: true } })
    const storeState = {
      settings: { ...DEFAULT_SETTINGS, apiKey: 'client-key-that-must-not-be-used' },
      tasks: [{
        id: 'history-task',
        prompt: '历史提示词',
        params: { ...DEFAULT_PARAMS },
        apiProvider: 'openai',
        apiProfileName: '历史配置',
        apiModel: 'historical-model',
        inputImageIds: [],
        outputImages: [],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
        elapsed: 1,
      }],
      detailTaskId: 'history-task',
      dismissedCodexCliPrompts: [],
      setDetailTaskId: vi.fn(),
      setLightboxImageId: vi.fn(),
      setMaskEditorImageId: vi.fn(),
      setConfirmDialog: vi.fn(),
      showToast: vi.fn(),
    }
    vi.doMock('../store', () => ({
      useStore: <T,>(selector: (state: typeof storeState) => T) => selector(storeState),
      getCachedImage: vi.fn(),
      ensureImageCached: vi.fn(async () => undefined),
      reuseConfig: vi.fn(),
      editOutputs: vi.fn(),
      removeTask: vi.fn(),
      updateTaskInStore: vi.fn(),
      showCodexCliPrompt: vi.fn(),
      getCodexCliPromptKey: vi.fn(() => 'runtime-config-unavailable'),
      retryTask: vi.fn(),
    }))
    const { default: DetailModal } = await import('./DetailModal')

    const markup = renderToStaticMarkup(<DetailModal />)

    expect(markup).toContain('历史提示词')
    expect(markup).toContain('historical-model')
  })
})

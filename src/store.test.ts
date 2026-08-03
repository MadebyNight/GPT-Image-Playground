import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from './types'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './lib/apiProfiles'
import type { StoredImage, StoredImageThumbnail, TaskRecord } from './types'
import { getSelectedImageMentionLabel } from './lib/promptImageMentions'
import { getEffectiveApiProfile, initializeRuntimeConfig, loadRuntimeConfig } from './lib/serverApiConfig'
import * as falAiImageApi from './lib/falAiImageApi'
vi.mock('./lib/db', () => {
  const tasks = new Map<string, TaskRecord>()
  const images = new Map<string, StoredImage>()
  const thumbnails = new Map<string, StoredImageThumbnail>()
  let imageSeq = 0

  return {
    CURRENT_THUMBNAIL_VERSION: 2,
    getAllTasks: async () => [...tasks.values()],
    putTask: async (task: TaskRecord) => {
      tasks.set(task.id, task)
      return task.id
    },
    deleteTask: async (id: string) => {
      tasks.delete(id)
    },
    clearTasks: async () => {
      tasks.clear()
    },
    getImage: async (id: string) => images.get(id),
    getImageThumbnail: async (id: string) => thumbnails.get(id),
    getStoredFreshImageThumbnail: async (id: string) => thumbnails.get(id),
    getAllImageIds: async () => [...images.keys()],
    getAllImages: async () => [...images.values()],
    putImage: async (image: StoredImage) => {
      images.set(image.id, image)
      return image.id
    },
    putImageThumbnail: async (thumbnail: StoredImageThumbnail) => {
      thumbnails.set(thumbnail.id, thumbnail)
      return thumbnail.id
    },
    deleteImage: async (id: string) => {
      images.delete(id)
      thumbnails.delete(id)
    },
    clearImages: async () => {
      images.clear()
      thumbnails.clear()
    },
    storeImage: async (dataUrl: string, source: StoredImage['source'] = 'upload') => {
      const id = `stored-image-${++imageSeq}`
      images.set(id, { id, dataUrl, source, createdAt: Date.now() })
      return id
    },
  }
})
import { clearImages, clearTasks, getAllTasks, getImage, putImage, putTask } from './lib/db'
import { editOutputs, getCodexCliPromptKey, getPersistedState, getTaskApiProfile, initStore, markInterruptedOpenAIRunningTasks, reuseConfig, saveOpenShopEdit, submitTask, useStore } from './store'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }
const imageB = { id: 'image-b', dataUrl: 'data:image/png;base64,b' }

afterEach(() => {
  initializeRuntimeConfig({ version: 1, serverApi: { enabled: false } })
  vi.useRealTimers()
  vi.restoreAllMocks()
})

beforeEach(() => {
  initializeRuntimeConfig({ version: 1, serverApi: { enabled: false } })
})

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'prompt',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

describe('mask draft lifecycle in store actions', () => {
  beforeEach(() => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      prompt: 'prompt',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      detailTaskId: null,
      lightboxImageId: null,
      lightboxImageList: [],
      showSettings: false,
      toast: null,
      confirmDialog: null,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('preserves an existing mask when quick edit-output adds outputs as references', async () => {
    const maskDraft = {
      targetImageId: imageA.id,
      maskDataUrl: 'data:image/png;base64,mask',
      updatedAt: 1,
    }
    useStore.setState({
      inputImages: [imageA],
      maskDraft,
    })

    await editOutputs(task({ outputImages: [imageA.id] }))

    expect(useStore.getState().maskDraft).toEqual(maskDraft)
  })

  it('clears an invalid mask draft when submit cannot find the mask target image', async () => {
    useStore.setState({
      inputImages: [imageA],
      maskDraft: {
        targetImageId: 'missing-image',
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 1,
      },
    })

    const submittedTaskId = await submitTask()

    expect(submittedTaskId).toBeNull()
    expect(useStore.getState().maskDraft).toBeNull()
  })

  it('preserves selected image mentions when replacing a mask target with an equivalent image id', () => {
    const replacement = { id: 'image-a-replacement', dataUrl: imageA.dataUrl }
    const prompt = `参考 ${getSelectedImageMentionLabel(0)} 生成`
    useStore.setState({
      prompt,
      inputImages: [imageA, imageB],
    })

    useStore.getState().setInputImages([replacement, imageB], {
      equivalentImageIds: { [imageA.id]: replacement.id },
    })

    const state = useStore.getState()
    expect(state.inputImages.map((img) => img.id)).toEqual([replacement.id, imageB.id])
    expect(state.prompt).toBe(prompt)
  })
})

describe('OpenShop 编辑历史', () => {
  beforeEach(() => {
    useStore.setState({
      tasks: [],
      inputImages: [],
      toast: null,
      showToast: vi.fn(),
    })
  })

  it('从 data URL 保存编辑结果，并保留源任务与完整溯源关系', async () => {
    const sourceTask = task({
      id: 'source-task',
      prompt: '原始提示词',
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
      outputImages: ['source-image-a', 'source-image-b'],
    })
    useStore.setState({ tasks: [sourceTask] })

    const created = await saveOpenShopEdit({
      sourceTaskId: sourceTask.id,
      outputImage: 'data:image/webp;base64,b3BlbnNob3A=',
    })

    expect(created).toMatchObject({
      prompt: sourceTask.prompt,
      params: sourceTask.params,
      apiProvider: 'openshop',
      origin: 'openshop',
      sourceTaskId: sourceTask.id,
      inputImageIds: sourceTask.outputImages,
      status: 'done',
      error: null,
      finishedAt: created.createdAt,
      elapsed: 0,
    })
    expect(created.params).not.toBe(sourceTask.params)
    expect(useStore.getState().tasks).toEqual([created, sourceTask])
    expect((await getAllTasks()).find((stored) => stored.id === created.id)).toEqual(created)
    expect(await getImage(created.outputImages[0])).toMatchObject({
      dataUrl: 'data:image/webp;base64,b3BlbnNob3A=',
      source: 'openshop',
    })
  })

  it('从 Blob 保存指定原图的编辑结果', async () => {
    const sourceTask = task({ id: 'blob-source-task', outputImages: ['source-image-a', 'source-image-b'] })
    useStore.setState({ tasks: [sourceTask] })

    const created = await saveOpenShopEdit({
      sourceTaskId: sourceTask.id,
      inputImageIds: ['source-image-b'],
      outputImage: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    })

    expect(created.inputImageIds).toEqual(['source-image-b'])
    expect(await getImage(created.outputImages[0])).toMatchObject({
      dataUrl: 'data:image/png;base64,AQID',
      source: 'openshop',
    })
  })
})

describe('interrupted OpenAI running tasks', () => {
  it('marks legacy and OpenAI running tasks as interrupted', () => {
    const now = 10_000
    const legacyRunning = task({ id: 'legacy-running', status: 'running', createdAt: 1_000, finishedAt: null, elapsed: null })
    const openAIRunning = task({ id: 'openai-running', apiProvider: 'openai', status: 'running', createdAt: 2_000, finishedAt: null, elapsed: null })
    const falRunning = task({ id: 'fal-running', apiProvider: 'fal', status: 'running', createdAt: 3_000, finishedAt: null, elapsed: null })
    const customAsyncRunning = task({ id: 'custom-running', apiProvider: 'custom-provider', customTaskId: 'task-1', status: 'running', createdAt: 4_000, finishedAt: null, elapsed: null })
    const restrictedAgentRunning = task({ id: 'agent-running', apiProvider: 'restricted-agent', origin: 'restricted-agent', agentExecutionId: 'execution-1', status: 'running', createdAt: 5_000, finishedAt: null, elapsed: null })
    const doneTask = task({ id: 'done-task', apiProvider: 'openai', status: 'done' })

    const result = markInterruptedOpenAIRunningTasks([legacyRunning, openAIRunning, falRunning, customAsyncRunning, restrictedAgentRunning, doneTask], now)

    expect(result.interruptedTasks.map((item) => item.id)).toEqual(['legacy-running', 'openai-running'])
    expect(result.tasks.find((item) => item.id === 'legacy-running')).toMatchObject({
      status: 'error',
      error: expect.stringContaining('请求中断'),
      finishedAt: now,
      elapsed: 9_000,
    })
    expect(result.tasks.find((item) => item.id === 'openai-running')).toMatchObject({
      status: 'error',
      error: expect.stringContaining('请求中断'),
      finishedAt: now,
      elapsed: 8_000,
    })
    expect(result.tasks.find((item) => item.id === 'fal-running')).toEqual(falRunning)
    expect(result.tasks.find((item) => item.id === 'custom-running')).toEqual(customAsyncRunning)
    expect(result.tasks.find((item) => item.id === 'agent-running')).toEqual(restrictedAgentRunning)
    expect(result.tasks.find((item) => item.id === 'done-task')).toEqual(doneTask)
  })

  it('marks incompatible recoverable tasks as interrupted in managed mode', () => {
    initializeRuntimeConfig({
      version: 1,
      serverApi: {
        enabled: true,
        provider: 'openai',
        model: 'server-model',
        apiMode: 'images',
        codexCli: false,
        responseFormatB64Json: false,
        timeoutSeconds: 600,
        proxyPath: '/api-proxy',
      },
    })
    const now = 10_000
    const falRunning = task({ id: 'fal-running', apiProvider: 'fal', status: 'running', createdAt: 3_000, finishedAt: null, elapsed: null })
    const customRecoverable = task({
      id: 'custom-recoverable',
      apiProvider: 'custom-provider',
      customTaskId: 'task-1',
      status: 'error',
      customRecoverable: true,
      createdAt: 4_000,
      finishedAt: null,
      elapsed: null,
    })

    const result = markInterruptedOpenAIRunningTasks([falRunning, customRecoverable], now)

    expect(result.interruptedTasks.map((item) => item.id)).toEqual(['fal-running', 'custom-recoverable'])
    expect(result.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'fal-running', status: 'error', falRecoverable: false }),
      expect.objectContaining({ id: 'custom-recoverable', status: 'error', customRecoverable: false }),
    ]))
  })
})

describe('persisted API task recovery', () => {
  const falProfile = createDefaultFalProfile({
    id: 'recovery-fal-profile',
    name: 'fal recovery',
    apiKey: 'local-fal-secret',
  })
  const customProfile = createDefaultOpenAIProfile({
    id: 'recovery-custom-profile',
    name: 'custom recovery',
    provider: 'custom-recovery',
    baseUrl: 'https://custom.example/v1',
    apiKey: 'local-custom-secret',
    model: 'custom-model',
  })
  const customProvider = {
    id: 'custom-recovery',
    name: 'Custom Recovery',
    template: 'http-image' as const,
    submit: {
      path: 'images/generations',
      method: 'POST' as const,
      contentType: 'json' as const,
      body: { model: '$profile.model', prompt: '$prompt' },
      taskIdPath: 'task_id',
    },
    poll: {
      path: 'images/tasks/{task_id}',
      method: 'GET' as const,
      intervalSeconds: 1,
      statusPath: 'status',
      successValues: ['SUCCESS'],
      failureValues: ['FAILURE'],
      result: {
        b64JsonPaths: ['data.*.b64_json'],
      },
    },
  }

  function createPersistedRecoveryTasks(): TaskRecord[] {
    return [
      task({
        id: 'fal-running-recovery',
        apiProvider: 'fal',
        apiProfileId: falProfile.id,
        falRequestId: 'fal-running-request',
        falEndpoint: 'fal-ai/flux/dev',
        status: 'running',
        finishedAt: null,
        elapsed: null,
      }),
      task({
        id: 'fal-recoverable-error',
        apiProvider: 'fal',
        apiProfileId: falProfile.id,
        falRequestId: 'fal-recoverable-request',
        falEndpoint: 'fal-ai/flux/dev',
        status: 'error',
        falRecoverable: true,
      }),
      task({
        id: 'custom-running-recovery',
        apiProvider: customProvider.id,
        apiProfileId: customProfile.id,
        customTaskId: 'custom-running-task',
        status: 'running',
        finishedAt: null,
        elapsed: null,
      }),
      task({
        id: 'custom-recoverable-error',
        apiProvider: customProvider.id,
        apiProfileId: customProfile.id,
        customTaskId: 'custom-recoverable-task',
        status: 'error',
        customRecoverable: true,
      }),
    ]
  }

  function expectRecoveryTasksTerminated(tasks: TaskRecord[]) {
    expect(tasks.map((item) => item.id)).toEqual([
      'fal-running-recovery',
      'fal-recoverable-error',
      'custom-running-recovery',
      'custom-recoverable-error',
    ])
    for (const recoveredTask of tasks) {
      expect(recoveredTask).toMatchObject({
        status: 'error',
        falRecoverable: false,
        customRecoverable: false,
      })
      expect(recoveredTask.error).toContain('服务端 API 配置不可用')
    }
  }

  function createSuccessfulCustomPollResponse() {
    return new Response(JSON.stringify({
      status: 'SUCCESS',
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    await clearTasks()
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        customProviders: [customProvider],
        profiles: [falProfile, customProfile],
        activeProfileId: falProfile.id,
      }),
      tasks: [],
      inputImages: [],
      showToast: vi.fn(),
    })
  })

  afterEach(async () => {
    await clearTasks()
  })

  it.each(['error', 'loading'] as const)(
    'does not schedule or recover persisted fal/custom tasks while runtime config is %s',
    async (runtimeStatus) => {
      const falRecoverySpy = vi.spyOn(falAiImageApi, 'getFalQueuedImageResult').mockResolvedValue({
        images: ['data:image/png;base64,aW1hZ2U='],
      })
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => createSuccessfulCustomPollResponse())
      let resolveRuntimeResponse: (response: Response) => void = () => undefined
      let loadPromise: Promise<void> | null = null

      if (runtimeStatus === 'loading') {
        const runtimeResponsePromise = new Promise<Response>((resolve) => {
          resolveRuntimeResponse = resolve
        })
        fetchMock.mockImplementationOnce(() => runtimeResponsePromise)
        loadPromise = loadRuntimeConfig()
        fetchMock.mockClear()
      } else {
        initializeRuntimeConfig(null)
      }

      await Promise.all(createPersistedRecoveryTasks().map((item) => putTask(item)))

      try {
        await initStore()
        const scheduledTimerCount = vi.getTimerCount()
        await vi.advanceTimersByTimeAsync(0)

        expect(scheduledTimerCount).toBe(0)
        expect(falRecoverySpy).not.toHaveBeenCalled()
        expect(fetchMock).not.toHaveBeenCalled()
        expectRecoveryTasksTerminated(useStore.getState().tasks)
        expectRecoveryTasksTerminated(await getAllTasks())
      } finally {
        if (loadPromise) {
          resolveRuntimeResponse(new Response(JSON.stringify({ version: 1, serverApi: { enabled: false } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }))
          await loadPromise
        }
      }
    },
  )

  it('stops scheduled recovery when runtime config becomes unavailable before the timer runs', async () => {
    const falRecoverySpy = vi.spyOn(falAiImageApi, 'getFalQueuedImageResult').mockResolvedValue({
      images: ['data:image/png;base64,aW1hZ2U='],
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => createSuccessfulCustomPollResponse())
    await Promise.all(createPersistedRecoveryTasks().map((item) => putTask(item)))

    await initStore()
    expect(vi.getTimerCount()).toBe(4)

    initializeRuntimeConfig(null)
    await vi.advanceTimersByTimeAsync(0)

    expect(falRecoverySpy).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expectRecoveryTasksTerminated(useStore.getState().tasks)
    expectRecoveryTasksTerminated(await getAllTasks())
  })

  it('preserves legacy fal/custom recovery while runtime config is ready and disabled', async () => {
    const falRecoverySpy = vi.spyOn(falAiImageApi, 'getFalQueuedImageResult').mockResolvedValue({
      images: ['data:image/png;base64,aW1hZ2U='],
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => createSuccessfulCustomPollResponse())
    await Promise.all(createPersistedRecoveryTasks().map((item) => putTask(item)))

    await initStore()
    await vi.advanceTimersByTimeAsync(0)

    expect(falRecoverySpy).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('input persistence setting', () => {
  beforeEach(() => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      prompt: 'prompt',
      inputImages: [imageA],
      dismissedCodexCliPrompts: [],
    })
  })

  it('persists input when restart input restore is enabled', () => {
    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('prompt')
    expect(persisted.inputImages).toEqual([{ id: imageA.id, dataUrl: '' }])
  })

  it('omits input when restart input restore is disabled', () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, persistInputOnRestart: false } })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted).not.toHaveProperty('prompt')
    expect(persisted).not.toHaveProperty('inputImages')
  })

  it('writes empty input when persisted input is cleared', () => {
    useStore.setState({ prompt: '', inputImages: [] })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('')
    expect(persisted.inputImages).toEqual([])
  })
})

describe('reused task API profile', () => {
  const openaiProfile = createDefaultOpenAIProfile({ id: 'openai-profile', apiKey: 'openai-key' })
  const falProfile = createDefaultFalProfile({ id: 'fal-profile', name: 'fal 配置', apiKey: 'fal-key' })

  beforeEach(() => {
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [openaiProfile, falProfile],
        activeProfileId: openaiProfile.id,
        reuseTaskApiProfileTemporarily: true,
      }),
      prompt: '',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      showSettings: false,
      toast: null,
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('resolves a task API profile by stored profile id', () => {
    const resolved = getTaskApiProfile(useStore.getState().settings, task({ apiProvider: 'fal', apiProfileId: falProfile.id }))

    expect(resolved?.id).toBe(falProfile.id)
  })

  it('reuses an OpenShop edit with the current API profile instead of reporting a missing OpenShop profile', async () => {
    await putImage({ id: imageA.id, dataUrl: imageA.dataUrl, source: 'openshop' })
    const confirmDialog = vi.fn()
    useStore.setState({ setConfirmDialog: confirmDialog })

    await reuseConfig(task({
      origin: 'openshop',
      apiProvider: 'openshop',
      apiProfileName: 'OpenShop',
      sourceTaskId: 'source-task',
      inputImageIds: [imageA.id],
      prompt: '编辑后的图片继续生成',
    }))

    expect(useStore.getState().inputImages).toEqual([imageA])
    expect(useStore.getState().prompt).toBe('编辑后的图片继续生成')
    expect(useStore.getState().reusedTaskApiProfileMissing).toBe(false)
    expect(confirmDialog).not.toHaveBeenCalled()
  })

  it('reuses the task API profile temporarily without switching the active profile', async () => {
    await reuseConfig(task({
      apiProvider: 'fal',
      apiProfileId: falProfile.id,
      params: { ...DEFAULT_PARAMS, n: 8, size: 'auto', quality: 'auto' },
    }))

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(openaiProfile.id)
    expect(state.reusedTaskApiProfileId).toBe(falProfile.id)
    expect(state.params).toMatchObject({ n: 4, size: '1360x1024', quality: 'high' })
    expect(state.showToast).toHaveBeenCalledWith('已临时复用该任务的 API 配置「fal 配置」', 'success')
  })

  it('keeps selected image mentions when reusing a task with different current input images', async () => {
    await clearImages()
    await putImage(imageA)
    await putImage(imageB)
    const taskPrompt = `参考 ${getSelectedImageMentionLabel(1)} 生成`

    useStore.setState({
      prompt: `当前 ${getSelectedImageMentionLabel(1)}`,
      inputImages: [
        { id: 'current-x', dataUrl: 'data:image/png;base64,x' },
        { id: 'current-y', dataUrl: 'data:image/png;base64,y' },
      ],
    })

    await reuseConfig(task({
      apiProvider: 'openai',
      apiProfileId: openaiProfile.id,
      prompt: taskPrompt,
      inputImageIds: [imageA.id, imageB.id],
    }))

    const state = useStore.getState()
    expect(state.inputImages.map((img) => img.id)).toEqual([imageA.id, imageB.id])
    expect(state.prompt).toBe(taskPrompt)
  })

  it('clears temporary reuse when switching current settings to the reused API profile', async () => {
    await reuseConfig(task({ apiProvider: 'fal', apiProfileId: falProfile.id }))

    useStore.getState().setSettings({ activeProfileId: falProfile.id })

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(falProfile.id)
    expect(state.reusedTaskApiProfileId).toBeNull()
    expect(state.reusedTaskApiProfileMissing).toBe(false)
  })

  it('normalizes reused params to the current API profile when temporary reuse is disabled', async () => {
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        reuseTaskApiProfileTemporarily: false,
      }),
    })

    await reuseConfig(task({
      apiProvider: 'fal',
      apiProfileId: falProfile.id,
      params: { ...DEFAULT_PARAMS, n: 8, size: 'auto', quality: 'auto' },
    }))

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(openaiProfile.id)
    expect(state.reusedTaskApiProfileId).toBeNull()
    expect(state.params).toMatchObject({ n: 8, size: 'auto', quality: 'auto' })
  })

  it('asks whether to submit with current API profile when the reused API profile is missing', async () => {
    await reuseConfig(task({ apiProvider: 'fal', apiProfileId: 'missing-profile' }))

    const state = useStore.getState()
    expect(state.tasks).toEqual([])
    expect(state.setConfirmDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '找不到 API 配置',
      message: '找不到复用任务所使用的 API 配置「未知配置」，要使用当前的 API 配置「默认」提交任务吗？',
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
    }))
    expect(state.showSettings).toBe(false)
  })
})

describe('server-managed API configuration', () => {
  const managedConfig = {
    version: 1 as const,
    serverApi: {
      enabled: true as const,
      provider: 'openai' as const,
      model: 'server-model',
      apiMode: 'images' as const,
      codexCli: false,
      responseFormatB64Json: false,
      timeoutSeconds: 600,
      proxyPath: '/api-proxy',
    },
  }
  const clientProfile = createDefaultOpenAIProfile({
    id: 'client-profile',
    apiKey: 'original-key',
    model: 'client-model',
  })
  const falProfile = createDefaultFalProfile({ id: 'fal-profile', name: 'fal 配置', apiKey: 'fal-key' })

  beforeEach(() => {
    initializeRuntimeConfig(managedConfig)
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [clientProfile, falProfile],
        activeProfileId: clientProfile.id,
        reuseTaskApiProfileTemporarily: true,
      }),
      prompt: '',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      showSettings: false,
      toast: null,
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('ignores fixed API settings while allowing custom managed model selection', () => {
    useStore.getState().setSettings({
      apiKey: 'attacker-key',
      model: 'attacker-model',
      activeProfileId: falProfile.id,
      clearInputAfterSubmit: true,
    })

    const settings = useStore.getState().settings
    expect(settings.profiles.find((profile) => profile.id === clientProfile.id)).toMatchObject({
      apiKey: 'original-key',
      model: 'attacker-model',
    })
    expect(settings.model).toBe('attacker-model')
    expect(settings.activeProfileId).toBe(clientProfile.id)
    expect(settings.clearInputAfterSubmit).toBe(true)
    expect(settings.reuseTaskApiProfileTemporarily).toBe(false)
  })

  it('persists allowed managed API mode and model selections into the active profile', () => {
    initializeRuntimeConfig({
      ...managedConfig,
      serverApi: {
        ...managedConfig.serverApi,
        modelOptions: ['server-model', 'gpt-5.5'],
        apiModeOptions: ['images', 'responses'],
      },
    })

    useStore.getState().setSettings({
      apiMode: 'responses',
      model: 'gpt-5.5',
    })

    const settings = useStore.getState().settings
    expect(settings.apiMode).toBe('responses')
    expect(settings.model).toBe('gpt-5.5')
    expect(settings.profiles.find((profile) => profile.id === settings.activeProfileId)).toMatchObject({
      apiMode: 'responses',
      model: 'gpt-5.5',
    })
    expect(getEffectiveApiProfile(settings)).toMatchObject({
      apiMode: 'responses',
      model: 'gpt-5.5',
    })
  })

  it('resolves every task to the managed profile', () => {
    const resolved = getTaskApiProfile(useStore.getState().settings, task({
      apiProvider: 'fal',
      apiProfileId: falProfile.id,
    }))

    expect(resolved).toEqual(getEffectiveApiProfile(useStore.getState().settings))
    expect(resolved).toMatchObject({ id: 'server-managed-openai', provider: 'openai', model: 'client-model' })
  })

  it('reuses only task input and parameters without selecting its API profile', async () => {
    await reuseConfig(task({
      apiProvider: 'fal',
      apiProfileId: falProfile.id,
      params: { ...DEFAULT_PARAMS, n: 8, size: 'auto', quality: 'auto' },
    }))

    const state = useStore.getState()
    expect(state.reusedTaskApiProfileId).toBeNull()
    expect(state.reusedTaskApiProfileMissing).toBe(false)
    expect(state.params).toMatchObject({ n: 8, size: 'auto', quality: 'auto' })
    expect(state.showToast).toHaveBeenCalledWith('已复用输入与参数', 'success')
  })

  it('submits with an empty client key and records managed task metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    useStore.setState({ prompt: 'prompt' })

    const submittedTaskId = await submitTask()

    const created = useStore.getState().tasks[0]
    expect(submittedTaskId).toBe(created.id)
    expect(created).toMatchObject({
      apiProvider: 'openai',
      apiProfileId: 'server-managed-openai',
      apiProfileName: '服务端统一配置',
      apiModel: 'client-model',
    })
    expect(useStore.getState().showSettings).toBe(false)
  })

  it('keeps input reuse available without reusing an API profile when runtime config is unavailable', async () => {
    initializeRuntimeConfig(null)

    await reuseConfig(task({
      apiProvider: 'fal',
      apiProfileId: falProfile.id,
      params: { ...DEFAULT_PARAMS, n: 8, size: 'auto', quality: 'auto' },
    }))

    const state = useStore.getState()
    expect(state.reusedTaskApiProfileId).toBeNull()
    expect(state.reusedTaskApiProfileMissing).toBe(false)
    expect(state.params).toMatchObject({ n: 8, size: 'auto', quality: 'auto' })
    expect(state.showToast).toHaveBeenCalledWith('已复用输入与参数', 'success')
  })

  it('uses a non-secret Codex prompt key when runtime config is unavailable', () => {
    initializeRuntimeConfig(null)

    expect(getCodexCliPromptKey(useStore.getState().settings)).toBe('runtime-config-unavailable')
  })
})

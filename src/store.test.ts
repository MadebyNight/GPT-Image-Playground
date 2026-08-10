import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from './types'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './lib/apiProfiles'
import type { StoredImage, StoredImageThumbnail, TaskRecord } from './types'
import { getSelectedImageMentionLabel } from './lib/promptImageMentions'
import { getEffectiveApiProfile, initializeRuntimeConfig, loadRuntimeConfig } from './lib/serverApiConfig'
import * as falAiImageApi from './lib/falAiImageApi'
const dbMockState = vi.hoisted(() => ({
  tasks: new Map<string, TaskRecord>(),
  images: new Map<string, StoredImage>(),
  thumbnails: new Map<string, StoredImageThumbnail>(),
  imageSeq: 0,
  getImage: vi.fn<(id: string) => Promise<StoredImage | undefined>>(),
  getAllImageIds: vi.fn<() => Promise<string[]>>(),
  deleteImage: vi.fn<(id: string) => Promise<void>>(),
}))
vi.mock('./lib/db', () => {
  const tasks = dbMockState.tasks
  const images = dbMockState.images
  const thumbnails = dbMockState.thumbnails

  return {
    CURRENT_THUMBNAIL_VERSION: 2,
    getAllTasks: async () => [...tasks.values()],
    putTask: vi.fn(async (task: TaskRecord) => {
      tasks.set(task.id, task)
      return task.id
    }),
    deleteTask: async (id: string) => {
      tasks.delete(id)
    },
    clearTasks: async () => {
      tasks.clear()
    },
    getImage: dbMockState.getImage,
    getImageThumbnail: async (id: string) => thumbnails.get(id),
    getStoredFreshImageThumbnail: async (id: string) => thumbnails.get(id),
    getAllImageIds: dbMockState.getAllImageIds,
    getAllImages: async () => [...images.values()],
    putImage: async (image: StoredImage) => {
      images.set(image.id, image)
      return image.id
    },
    putImageThumbnail: async (thumbnail: StoredImageThumbnail) => {
      thumbnails.set(thumbnail.id, thumbnail)
      return thumbnail.id
    },
    deleteImage: dbMockState.deleteImage,
    clearImages: async () => {
      images.clear()
      thumbnails.clear()
    },
    storeImage: async (dataUrl: string, source: StoredImage['source'] = 'upload') => {
      const id = `stored-image-${++dbMockState.imageSeq}`
      images.set(id, { id, dataUrl, source, createdAt: Date.now() })
      return id
    },
  }
})
import { clearImages, clearTasks, getAllTasks, getImage, putImage, putTask } from './lib/db'
import { editOutputs, getCodexCliPromptKey, getComposerDraftSnapshot, getPendingTaskPersistenceCountForTests, getPersistedState, getTaskApiProfile, initStore, markInterruptedOpenAIRunningTasks, mergePersistedState, reuseConfig, saveOpenShopEdit, submitTask, updateTaskInStore, useStore } from './store'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }
const imageB = { id: 'image-b', dataUrl: 'data:image/png;base64,b' }

afterEach(() => {
  initializeRuntimeConfig({ version: 1, serverApi: { enabled: false } })
  vi.useRealTimers()
  vi.restoreAllMocks()
})

beforeEach(() => {
  initializeRuntimeConfig({ version: 1, serverApi: { enabled: false } })
  dbMockState.getImage.mockClear()
  dbMockState.getAllImageIds.mockClear()
  dbMockState.deleteImage.mockClear()
  dbMockState.getImage.mockImplementation(async (id) => dbMockState.images.get(id))
  dbMockState.getAllImageIds.mockImplementation(async () => [...dbMockState.images.keys()])
  dbMockState.deleteImage.mockImplementation(async (id) => {
    dbMockState.images.delete(id)
    dbMockState.thumbnails.delete(id)
  })
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
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
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key' })
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

  it('keeps persisted Agent partial text when a refresh marks the running task interrupted', () => {
    const runningAgent = task({
      id: 'agent-partial-refresh',
      origin: 'agent',
      status: 'running',
      createdAt: 1_000,
      finishedAt: null,
      elapsed: null,
      agentAssistantText: '刷新前已持久化 partial',
    })

    const result = markInterruptedOpenAIRunningTasks([runningAgent], 5_000)

    expect(result.tasks[0]).toMatchObject({
      status: 'error',
      error: '请求中断',
      agentAssistantText: '刷新前已持久化 partial',
      finishedAt: 5_000,
    })
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

describe('initStore composer concurrency', () => {
  const emptyDraft = (scope: 'gallery' | 'chat' | 'tool') => ({
    composerScope: scope,
    prompt: '',
    inputImages: [],
    maskDraft: null,
    params: { ...DEFAULT_PARAMS },
    reusedTaskApiProfileId: null,
    reusedTaskApiProfileName: null,
    reusedTaskApiProfileMissing: false,
    composerVersion: 0,
  })

  beforeEach(async () => {
    vi.stubGlobal('window', { requestIdleCallback: vi.fn() })
    await clearTasks()
    await clearImages()
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      composerScope: 'gallery',
      composerDrafts: {
        gallery: emptyDraft('gallery'),
        chat: emptyDraft('chat'),
        tool: emptyDraft('tool'),
      },
      composerVersion: 0,
      prompt: '',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      tasks: [],
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps an image added after the initialization snapshot while image ids are loading', async () => {
    const imageIds = deferred<string[]>()
    dbMockState.getAllImageIds.mockImplementationOnce(() => imageIds.promise)
    const initializing = initStore()
    await vi.waitFor(() => expect(dbMockState.getAllImageIds).toHaveBeenCalledOnce())

    const liveImage = {
      id: 'image-added-during-id-scan',
      dataUrl: 'data:image/png;base64,bGl2ZQ==',
      source: 'upload' as const,
      createdAt: Date.now(),
    }
    await putImage(liveImage)
    useStore.getState().addInputImage({ id: liveImage.id, dataUrl: liveImage.dataUrl })
    imageIds.resolve([liveImage.id])

    await initializing

    expect(getComposerDraftSnapshot('gallery').inputImages).toEqual([{ id: liveImage.id, dataUrl: liveImage.dataUrl }])
    expect(useStore.getState().inputImages).toEqual([{ id: liveImage.id, dataUrl: liveImage.dataUrl }])
    expect(await getImage(liveImage.id)).toEqual(liveImage)
    expect(dbMockState.deleteImage).not.toHaveBeenCalledWith(liveImage.id)
  })

  it('does not overwrite a changed prompt, params or new image while a persisted image is restoring', async () => {
    const persistedImage = {
      id: 'persisted-chat-image',
      dataUrl: 'data:image/png;base64,b2xk',
      source: 'upload' as const,
      createdAt: 1,
    }
    await putImage(persistedImage)
    useStore.setState((state) => ({
      composerDrafts: {
        ...state.composerDrafts,
        chat: {
          ...emptyDraft('chat'),
          inputImages: [{ id: persistedImage.id, dataUrl: '' }],
        },
      },
    }))
    const storedImage = deferred<StoredImage | undefined>()
    dbMockState.getImage.mockImplementationOnce(() => storedImage.promise)
    const initializing = initStore()
    await vi.waitFor(() => expect(dbMockState.getImage).toHaveBeenCalledWith(persistedImage.id))

    const liveImage = {
      id: 'image-added-during-restore',
      dataUrl: 'data:image/png;base64,bmV3',
      source: 'upload' as const,
      createdAt: Date.now(),
    }
    await putImage(liveImage)
    useStore.getState().setPrompt('启动期间的新需求')
    useStore.getState().setParams({ quality: 'high' })
    useStore.getState().addInputImage({ id: liveImage.id, dataUrl: liveImage.dataUrl })
    storedImage.resolve(persistedImage)

    await initializing

    expect(getComposerDraftSnapshot('gallery')).toMatchObject({
      prompt: '启动期间的新需求',
      params: { quality: 'high' },
      inputImages: [{ id: liveImage.id, dataUrl: liveImage.dataUrl }],
    })
    expect(await getImage(liveImage.id)).toEqual(liveImage)
    expect(dbMockState.deleteImage).not.toHaveBeenCalledWith(liveImage.id)
  })

  it('keeps images referenced only by a pending task persistence snapshot', async () => {
    const pendingImage = {
      id: 'pending-task-image',
      dataUrl: 'data:image/png;base64,cGVuZGluZw==',
      source: 'generated' as const,
      createdAt: Date.now(),
    }
    await putImage(pendingImage)
    useStore.getState().setTasks([task({ id: 'pending-task', outputImages: [] })])
    const persistence = deferred<void>()
    vi.mocked(putTask).mockImplementationOnce(async (record) => {
      await persistence.promise
      dbMockState.tasks.set(record.id, record)
      return record.id
    })
    updateTaskInStore('pending-task', { outputImages: [pendingImage.id] })
    await vi.waitFor(() => expect(getPendingTaskPersistenceCountForTests()).toBe(1))
    useStore.getState().setTasks([])

    await initStore()

    expect(await getImage(pendingImage.id)).toEqual(pendingImage)
    expect(dbMockState.deleteImage).not.toHaveBeenCalledWith(pendingImage.id)
    persistence.resolve()
    await vi.waitFor(() => expect(getPendingTaskPersistenceCountForTests()).toBe(0))
  })
})

describe('submitted composer snapshot', () => {
  beforeEach(() => {
    vi.mocked(putTask).mockClear()
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key' })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        clearInputAfterSubmit: true,
        profiles: [profile],
        activeProfileId: profile.id,
      }),
      prompt: '旧草稿',
      inputImages: [imageA],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      composerVersion: 0,
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      tasks: [],
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('does not clear a newer draft after asynchronous task creation', async () => {
    const result = { images: ['data:image/png;base64,aW1hZ2U='], actualParams: {} }
    const submitting = submitTask({ callApi: vi.fn().mockResolvedValue(result) })
    useStore.getState().setPrompt('用户刚输入的新草稿')
    useStore.getState().setParams({ size: '1536x1024' })
    useStore.getState().setInputImages([imageB])

    const taskId = await submitting
    const created = useStore.getState().tasks.find((item) => item.id === taskId)

    expect(taskId).not.toBeNull()
    expect(created).toMatchObject({
      prompt: '旧草稿',
      inputImageIds: [imageA.id],
      params: expect.objectContaining({ size: DEFAULT_PARAMS.size }),
    })
    expect(useStore.getState().prompt).toBe('用户刚输入的新草稿')
    expect(useStore.getState().inputImages).toEqual([imageB])
    expect(useStore.getState().params.size).toBe('1536x1024')
  })

  it('does not clear a newer composer version when the new draft differs only by whitespace', async () => {
    useStore.setState({ prompt: '尾部空白测试' })
    const submitting = submitTask({
      draftSnapshot: {
        prompt: '尾部空白测试',
        inputImages: [],
        maskDraft: null,
        params: { ...DEFAULT_PARAMS },
        reusedTaskApiProfileId: null,
        reusedTaskApiProfileName: null,
        reusedTaskApiProfileMissing: false,
        composerVersion: useStore.getState().composerVersion,
      },
      callApi: vi.fn().mockResolvedValue({ images: [], actualParams: {} }),
    })
    useStore.getState().setPrompt('尾部空白测试  \n')

    await submitting

    expect(useStore.getState().prompt).toBe('尾部空白测试  \n')
  })

  it('persists assistant partial text on failure while keeping the task in error', async () => {
    useStore.setState({ prompt: '会失败的 Agent 请求', inputImages: [] })
    const streamError = Object.assign(new Error('流式响应中断'), {
      agentAssistantText: '已返回但未完成的 partial 文本',
    })
    const taskId = await submitTask({
      callApi: vi.fn().mockRejectedValue(streamError),
      taskMetadata: {
        origin: 'agent',
        agentConversationId: 'conversation-partial',
        agentTurn: 1,
      },
    })

    await vi.waitFor(() => {
      expect(useStore.getState().tasks.find((item) => item.id === taskId)).toMatchObject({
        status: 'error',
        error: '流式响应中断',
        agentAssistantText: '已返回但未完成的 partial 文本',
      })
    })
    expect((await getAllTasks()).find((item) => item.id === taskId)).toMatchObject({
      status: 'error',
      error: '流式响应中断',
      agentAssistantText: '已返回但未完成的 partial 文本',
    })
  })

  it('publishes an Agent error terminal only after its partial text is persisted', async () => {
    let releaseTerminal!: () => void
    const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve })
    vi.mocked(putTask)
      .mockImplementationOnce(async (record) => {
        dbMockState.tasks.set(record.id, record)
        return record.id
      })
      .mockImplementationOnce(async (record) => {
        await terminalGate
        dbMockState.tasks.set(record.id, record)
        return record.id
      })
    useStore.setState({ prompt: '持久化后发布终态', inputImages: [] })
    const streamError = Object.assign(new Error('流式响应中断'), {
      agentAssistantText: '先落库的 partial 文本',
    })

    const taskId = await submitTask({
      callApi: vi.fn().mockRejectedValue(streamError),
      taskMetadata: {
        origin: 'agent',
        agentConversationId: 'conversation-terminal-order',
        agentTurn: 1,
      },
    })
    await vi.waitFor(() => expect(putTask).toHaveBeenCalledTimes(2))

    expect(useStore.getState().tasks.find((item) => item.id === taskId)).toMatchObject({
      status: 'running',
      error: null,
    })
    expect(getPendingTaskPersistenceCountForTests()).toBe(1)

    releaseTerminal()
    await vi.waitFor(() => {
      expect(useStore.getState().tasks.find((item) => item.id === taskId)).toMatchObject({
        status: 'error',
        error: '流式响应中断',
        agentAssistantText: '先落库的 partial 文本',
      })
    })
    expect(dbMockState.tasks.get(String(taskId))).toMatchObject({
      status: 'error',
      agentAssistantText: '先落库的 partial 文本',
    })
    await vi.waitFor(() => expect(getPendingTaskPersistenceCountForTests()).toBe(0))
  })

  it('does not publish a terminal state when its IndexedDB transaction rejects', async () => {
    vi.mocked(putTask)
      .mockImplementationOnce(async (record) => {
        dbMockState.tasks.set(record.id, record)
        return record.id
      })
      .mockRejectedValueOnce(new Error('IndexedDB transaction aborted'))
    useStore.setState({ prompt: '终态事务失败', inputImages: [] })

    const taskId = await submitTask({
      callApi: vi.fn().mockRejectedValue(Object.assign(new Error('上游失败'), {
        agentAssistantText: '不应伪发布的 partial',
      })),
      taskMetadata: {
        origin: 'agent',
        agentConversationId: 'conversation-terminal-abort',
        agentTurn: 1,
      },
    })
    await vi.waitFor(() => expect(putTask).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(getPendingTaskPersistenceCountForTests()).toBe(0))

    expect(useStore.getState().tasks.find((item) => item.id === taskId)).toMatchObject({
      status: 'running',
      error: null,
    })
    expect(dbMockState.tasks.get(String(taskId))).toMatchObject({ status: 'running', error: null })
  })

  it('keeps a queued terminal snapshot when a late running patch arrives', async () => {
    let releaseTerminal!: () => void
    const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve })
    vi.mocked(putTask)
      .mockImplementationOnce(async (record) => {
        dbMockState.tasks.set(record.id, record)
        return record.id
      })
      .mockImplementationOnce(async (record) => {
        await terminalGate
        dbMockState.tasks.set(record.id, record)
        return record.id
      })
    useStore.setState({ prompt: '晚到 running patch', inputImages: [] })

    const taskId = await submitTask({
      callApi: vi.fn().mockRejectedValue(new Error('最终失败')),
      taskMetadata: {
        origin: 'agent',
        agentConversationId: 'conversation-late-running',
        agentTurn: 1,
      },
    })
    await vi.waitFor(() => expect(putTask).toHaveBeenCalledTimes(2))
    updateTaskInStore(String(taskId), {
      status: 'running',
      error: null,
      customTaskId: 'late-progress-id',
      finishedAt: null,
      elapsed: null,
    })
    expect(putTask).toHaveBeenCalledTimes(2)

    releaseTerminal()
    await vi.waitFor(() => {
      expect(useStore.getState().tasks.find((item) => item.id === taskId)).toMatchObject({
        status: 'error',
        error: '最终失败',
        customTaskId: 'late-progress-id',
      })
    })
    await vi.waitFor(() => expect(putTask).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(getPendingTaskPersistenceCountForTests()).toBe(0))
    expect(dbMockState.tasks.get(String(taskId))).toMatchObject({
      status: 'error',
      error: '最终失败',
      customTaskId: 'late-progress-id',
    })
  })
})

describe('mode-scoped composer drafts', () => {
  beforeEach(() => {
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key' })
    const emptyDraft = {
      prompt: '',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      composerVersion: 0,
    }
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        clearInputAfterSubmit: true,
        profiles: [profile],
        activeProfileId: profile.id,
      }),
      composerScope: 'chat',
      composerDrafts: {
        gallery: { ...emptyDraft, params: { ...DEFAULT_PARAMS } },
        chat: { ...emptyDraft, params: { ...DEFAULT_PARAMS } },
        tool: { ...emptyDraft, params: { ...DEFAULT_PARAMS } },
      },
      ...emptyDraft,
      maskEditorImageId: null,
      tasks: [],
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('isolates prompt, images, mask, params, reused profile and version between Chat and Tool', () => {
    useStore.getState().setPrompt('Chat 草稿')
    useStore.getState().setInputImages([imageA])
    useStore.getState().setMaskDraft({ targetImageId: imageA.id, maskDataUrl: 'data:image/png;base64,mask-chat', updatedAt: 1 })
    useStore.getState().setParams({ size: '1536x1024' })
    useStore.getState().setReusedTaskApiProfile('chat-profile', true, 'Chat Profile')
    const chatVersion = useStore.getState().composerVersion

    useStore.getState().setComposerScope('tool')
    expect(getComposerDraftSnapshot()).toMatchObject({
      composerScope: 'tool',
      prompt: '',
      inputImages: [],
      maskDraft: null,
      params: DEFAULT_PARAMS,
      reusedTaskApiProfileId: null,
      composerVersion: 0,
    })

    useStore.getState().setPrompt('Tool 草稿')
    useStore.getState().setInputImages([imageB])
    useStore.getState().setParams({ quality: 'high' })
    const toolVersion = useStore.getState().composerVersion

    useStore.getState().setComposerScope('chat')
    expect(getComposerDraftSnapshot()).toMatchObject({
      composerScope: 'chat',
      prompt: 'Chat 草稿',
      inputImages: [imageA],
      maskDraft: { targetImageId: imageA.id },
      params: { size: '1536x1024' },
      reusedTaskApiProfileId: 'chat-profile',
      reusedTaskApiProfileMissing: true,
      composerVersion: chatVersion,
    })
    expect(toolVersion).toBeGreaterThan(0)
  })

  it('clears only the submitted source mode when another mode becomes active', async () => {
    useStore.getState().setPrompt('Chat 待提交')
    const chatSnapshot = getComposerDraftSnapshot()
    useStore.getState().setComposerScope('tool')
    useStore.getState().setPrompt('Tool 新草稿')

    await submitTask({
      draftSnapshot: chatSnapshot,
      callApi: vi.fn().mockResolvedValue({ images: [], actualParams: {} }),
    })

    expect(useStore.getState().prompt).toBe('Tool 新草稿')
    useStore.getState().setComposerScope('chat')
    expect(useStore.getState().prompt).toBe('')
    useStore.getState().setComposerScope('tool')
    expect(useStore.getState().prompt).toBe('Tool 新草稿')
  })

  it('maps the legacy persisted single draft to Chat without leaking it into Tool', () => {
    const merged = mergePersistedState({
      settings: { ...DEFAULT_SETTINGS },
      prompt: '旧版单草稿',
      inputImages: [{ id: imageA.id, dataUrl: '' }],
      params: { ...DEFAULT_PARAMS, quality: 'high' },
    }, useStore.getState())

    expect(merged.composerDrafts.chat).toMatchObject({
      prompt: '旧版单草稿',
      inputImages: [{ id: imageA.id, dataUrl: '' }],
      params: { quality: 'high' },
    })
    expect(merged.composerDrafts.tool.prompt).toBe('')
    expect(merged.composerDrafts.tool.inputImages).toEqual([])
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

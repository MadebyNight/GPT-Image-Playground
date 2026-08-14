import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type TaskParams, type TaskRecord } from '../types'
import { unifiedAgentGatewayFixture } from '../test/fixtures/unifiedAgentGateway'

const mocks = vi.hoisted(() => {
  const appState = {
    tasks: [] as TaskRecord[],
    settings: {
      clearInputAfterSubmit: false,
      agentStreaming: true,
      agentImageCount: 1,
    },
    setTasks: vi.fn((tasks: TaskRecord[]) => { appState.tasks = tasks }),
    showToast: vi.fn(),
  }
  const draft = {
    composerScope: 'agent' as const,
    prompt: '',
    inputImages: [] as Array<{ id: string; dataUrl: string }>,
    maskDraft: null,
    params: {
      size: 'auto',
      quality: 'auto' as const,
      output_format: 'png' as const,
      output_compression: null,
      moderation: 'auto' as const,
      n: 1,
    } as TaskParams,
    reusedTaskApiProfileId: null,
    reusedTaskApiProfileName: null,
    reusedTaskApiProfileMissing: false,
    composerVersion: 7,
  }
  return {
    appState,
    draft,
    putTask: vi.fn(),
    getImage: vi.fn(),
    storeImage: vi.fn(async (dataUrl: string) => `stored:${dataUrl}`),
    updateTask: vi.fn((taskId: string, patch: Partial<TaskRecord>) => {
      appState.tasks = appState.tasks.map((task) => task.id === taskId ? { ...task, ...patch } : task)
    }),
    clearComposerDraft: vi.fn(),
    createPlanRequest: vi.fn(),
    observeAutoPipeline: vi.fn(),
    cancelAutoPipeline: vi.fn(),
    createAutoPipeline: vi.fn(),
    responsesSubmit: vi.fn(),
    cancelResponses: vi.fn(),
    responsesUsable: true,
    gatewayUsable: true,
  }
})

vi.mock('../store', () => ({
  useStore: { getState: () => mocks.appState },
  getComposerDraftSnapshot: vi.fn(() => ({
    ...mocks.draft,
    inputImages: mocks.draft.inputImages.map((image) => ({ ...image })),
    params: { ...mocks.draft.params },
  })),
  clearComposerDraft: mocks.clearComposerDraft,
  updateTaskInStore: mocks.updateTask,
}))

vi.mock('../lib/db', () => ({
  putTask: mocks.putTask,
  getImage: mocks.getImage,
  storeImage: mocks.storeImage,
}))

vi.mock('../restrictedAgentStore', () => ({
  createRestrictedAgentPlanRequestFromDraft: mocks.createPlanRequest,
  observeAutoPipelineExecution: mocks.observeAutoPipeline,
  cancelAutoPipelineTaskExecution: mocks.cancelAutoPipeline,
}))

vi.mock('./restrictedAgentApi', () => ({
  createAutoPipeline: mocks.createAutoPipeline,
}))

vi.mock('./legacyAgentExecutor', () => ({
  storeBackedAgentExecutor: { submit: mocks.responsesSubmit },
  cancelAgentTask: mocks.cancelResponses,
}))

vi.mock('./serverApiConfig', () => ({
  getAgentCapabilities: () => ({ responsesUsable: mocks.responsesUsable }),
  isRestrictedAgentEnabled: () => mocks.gatewayUsable,
}))

import {
  cancelUnifiedAgentTask,
  retryUnifiedAgentTask,
  submitUnifiedAgentTurn,
} from './unifiedAgentExecutor'

function configurePlanRequest() {
  mocks.createPlanRequest.mockImplementation((snapshot: typeof mocks.draft) => ({
    request: snapshot.prompt,
    size: snapshot.params.size,
    quality: snapshot.params.quality,
    outputFormat: snapshot.params.output_format,
    outputCompression: snapshot.params.output_compression,
    moderation: snapshot.params.moderation,
    imageCount: snapshot.params.n,
    inputs: snapshot.inputImages.map((image) => ({
      role: 'reference' as const,
      browserImageId: image.id,
      sourceTaskId: null,
      dataUrl: image.dataUrl,
    })),
    temporaryProfile: { id: null, name: null, missing: false },
  }))
}

function setDraft(prompt: string, inputImages: Array<{ id: string; dataUrl: string }> = []) {
  mocks.draft.prompt = prompt
  mocks.draft.inputImages = inputImages
  mocks.draft.params = { ...DEFAULT_PARAMS }
  mocks.draft.maskDraft = null
}

beforeEach(() => {
  mocks.appState.tasks = []
  mocks.appState.setTasks.mockClear()
  mocks.appState.showToast.mockClear()
  mocks.putTask.mockReset()
  mocks.getImage.mockReset()
  mocks.storeImage.mockClear()
  mocks.updateTask.mockClear()
  mocks.clearComposerDraft.mockClear()
  mocks.createPlanRequest.mockReset()
  mocks.observeAutoPipeline.mockReset()
  mocks.cancelAutoPipeline.mockReset()
  mocks.createAutoPipeline.mockReset()
  mocks.responsesSubmit.mockReset()
  mocks.cancelResponses.mockReset()
  mocks.responsesUsable = true
  mocks.gatewayUsable = true
  configurePlanRequest()
  setDraft('生成一张普通海报')
  mocks.createAutoPipeline.mockResolvedValue({
    plan: structuredClone(unifiedAgentGatewayFixture.plan),
    execution: structuredClone(unifiedAgentGatewayFixture.execution),
    assetBindings: [],
  })
})

describe('unified Agent executor', () => {
  it('严格尺寸回合自动提交 Gateway，不调用确认流或 Responses', async () => {
    setDraft('生成一张 870×220 的夏日咖啡横幅')

    const taskId = await submitUnifiedAgentTurn({ conversationId: 'conversation-1' })

    expect(taskId).toBeTruthy()
    expect(mocks.createAutoPipeline).toHaveBeenCalledTimes(1)
    expect(mocks.createAutoPipeline).toHaveBeenCalledWith(expect.objectContaining({
      imageCount: 1,
      finalOutputSpec: expect.objectContaining({ width: 870, height: 220, fit: 'cover', position: 'center' }),
    }))
    expect(mocks.responsesSubmit).not.toHaveBeenCalled()
    const task = mocks.appState.tasks.find((candidate) => candidate.id === taskId)
    expect(task).toMatchObject({
      origin: 'agent',
      agentConversationId: 'conversation-1',
      agentTurn: 1,
      agentRoute: 'tool_pipeline',
      agentFallbackForbidden: true,
      agentPlanId: unifiedAgentGatewayFixture.plan.id,
      agentExecutionId: unifiedAgentGatewayFixture.execution.id,
      agentExecutionRoute: 'gateway_image_generate',
    })
    expect(mocks.observeAutoPipeline).toHaveBeenCalledWith(taskId, expect.objectContaining({
      execution: expect.objectContaining({ id: unifiedAgentGatewayFixture.execution.id }),
    }))
  })

  it('Gateway 缺失时将严格约束写为失败回合，且绝不调用 Responses', async () => {
    mocks.gatewayUsable = false
    setDraft('把这张图顺时针旋转 90°')

    const taskId = await submitUnifiedAgentTurn({ conversationId: 'conversation-1' })

    const task = mocks.appState.tasks.find((candidate) => candidate.id === taskId)
    expect(task).toMatchObject({
      origin: 'agent',
      status: 'error',
      agentRoute: 'tool_pipeline',
      agentFallbackForbidden: true,
    })
    expect(mocks.createAutoPipeline).not.toHaveBeenCalled()
    expect(mocks.responsesSubmit).not.toHaveBeenCalled()
  })

  it('普通生成仍委托给带流式能力的 Responses 执行器，并冻结路由审计', async () => {
    mocks.responsesSubmit.mockImplementation(async () => {
      const task: TaskRecord = {
        id: 'responses-task',
        prompt: mocks.draft.prompt,
        params: { ...DEFAULT_PARAMS },
        inputImageIds: [],
        outputImages: [],
        status: 'running',
        error: null,
        createdAt: 1,
        finishedAt: null,
        elapsed: null,
        origin: 'agent',
        agentConversationId: 'conversation-1',
        agentTurn: 1,
      }
      mocks.appState.tasks = [task]
      return task.id
    })

    await expect(submitUnifiedAgentTurn({ conversationId: 'conversation-1' })).resolves.toBe('responses-task')

    expect(mocks.responsesSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '生成一张普通海报',
      conversationId: 'conversation-1',
      stream: true,
    }))
    expect(mocks.createAutoPipeline).not.toHaveBeenCalled()
    expect(mocks.updateTask).toHaveBeenCalledWith('responses-task', expect.objectContaining({
      agentRoute: 'responses_image',
      agentFallbackForbidden: false,
      agentExecutionRoute: 'responses_image',
    }))
  })

  it('澄清和不支持请求写入当前会话的本地文本回合', async () => {
    setDraft('把上一张图旋转 90°')
    const clarifyId = await submitUnifiedAgentTurn({ conversationId: 'conversation-1' })
    setDraft('导出为 GIF 格式')
    const unsupportedId = await submitUnifiedAgentTurn({ conversationId: 'conversation-1' })

    expect(mocks.appState.tasks.find((task) => task.id === clarifyId)).toMatchObject({
      status: 'done',
      agentRoute: 'clarify',
      agentAssistantText: expect.stringContaining('历史图片尚未显式绑定'),
      agentTurn: 1,
    })
    expect(mocks.appState.tasks.find((task) => task.id === unsupportedId)).toMatchObject({
      status: 'done',
      agentRoute: 'unsupported',
      agentAssistantText: expect.stringContaining('GIF'),
      agentTurn: 2,
    })
    expect(mocks.createAutoPipeline).not.toHaveBeenCalled()
    expect(mocks.responsesSubmit).not.toHaveBeenCalled()
  })

  it('重试严格回合复用冻结的显式输入和规格，并创建同会话新 turn', async () => {
    const original: TaskRecord = {
      id: 'previous-task',
      prompt: '生成一张 870×220 的夏日咖啡横幅',
      params: { ...DEFAULT_PARAMS },
      inputImageIds: ['image-1'],
      outputImages: [],
      status: 'error',
      error: 'Gateway failed',
      createdAt: 1,
      finishedAt: 2,
      elapsed: 1,
      origin: 'agent',
      agentConversationId: 'conversation-1',
      agentTurn: 1,
      agentRoute: 'tool_pipeline',
      agentRouteReason: '严格尺寸',
      agentHardConstraints: ['精确尺寸 870×220px'],
      agentFallbackForbidden: true,
      agentFinalOutputSpec: { width: 870, height: 220, fit: 'cover', position: 'center', outputFormat: 'png', outputCompression: null },
    }
    mocks.appState.tasks = [original]
    mocks.getImage.mockResolvedValue({ id: 'image-1', dataUrl: 'data:image/png;base64,a' })

    const retryTaskId = await retryUnifiedAgentTask(original)

    expect(retryTaskId).toBeTruthy()
    expect(mocks.createAutoPipeline).toHaveBeenCalledWith(expect.objectContaining({
      request: original.prompt,
      inputs: [expect.objectContaining({ browserImageId: 'image-1' })],
      finalOutputSpec: original.agentFinalOutputSpec,
    }))
    const retryTask = mocks.appState.tasks.find((task) => task.id === retryTaskId)
    expect(retryTask).toMatchObject({ agentConversationId: 'conversation-1', agentTurn: 2 })
  })

  it('按任务取消：Gateway task 交给对应 execution，Responses task 仅取消自己的流', async () => {
    const gatewayTask = {
      id: 'gateway-task',
      prompt: '严格尺寸',
      params: { ...DEFAULT_PARAMS },
      inputImageIds: [],
      outputImages: [],
      status: 'running' as const,
      error: null,
      createdAt: 1,
      finishedAt: null,
      elapsed: null,
      origin: 'agent' as const,
      agentExecutionId: unifiedAgentGatewayFixture.execution.id,
      agentPlanSnapshot: structuredClone(unifiedAgentGatewayFixture.plan) as unknown as TaskRecord['agentPlanSnapshot'],
    }
    const responsesTask = { ...gatewayTask, id: 'responses-task', agentExecutionId: undefined, agentPlanSnapshot: undefined }

    await cancelUnifiedAgentTask(gatewayTask)
    await cancelUnifiedAgentTask(responsesTask)

    expect(mocks.cancelAutoPipeline).toHaveBeenCalledWith('gateway-task')
    expect(mocks.cancelResponses).toHaveBeenCalledWith('responses-task')
  })
})

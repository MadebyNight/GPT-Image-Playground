import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenShopToolLocalRun, RestrictedAgentExecution, RestrictedAgentPlan, TaskRecord } from './types'

const mocks = vi.hoisted(() => {
  const appState = {
    prompt: '生成一张海报',
    params: {
      size: '1024x1024',
      quality: 'high' as const,
      output_format: 'png' as const,
      output_compression: null,
      moderation: 'auto' as const,
      n: 1,
    },
    inputImages: [] as Array<{ id: string; dataUrl: string }>,
    maskDraft: null as null | { targetImageId: string; maskDataUrl: string; updatedAt: number },
    composerVersion: 7,
    tasks: [] as TaskRecord[],
    settings: { clearInputAfterSubmit: false },
    showToast: vi.fn(),
    setTasks: vi.fn((tasks: TaskRecord[]) => { appState.tasks = tasks }),
  }
  return {
    appState,
    appSubscriber: null as null | (() => void),
    createPlan: vi.fn(),
    executePlan: vi.fn(),
    computeHash: vi.fn(),
    putTask: vi.fn(),
    updateTask: vi.fn(),
    clearComposerDraft: vi.fn(),
    durableRun: null as OpenShopToolLocalRun | null,
    outputDraft: null as null | { runId: string; blob: Blob; filename: string; document: { canvas: { width: number; height: number }; primaryImage: { present: true } }; createdAt: number; expiresAt: number },
    createLocalRunRecord: vi.fn(),
    claimLocalRun: vi.fn(),
    transitionLocalRun: vi.fn(),
    storeLocalExport: vi.fn(),
    getLocalRun: vi.fn(),
    getOutputDraft: vi.fn(),
    getVerifiedCompletedTask: vi.fn(),
    cleanupDrafts: vi.fn(),
    runOpenShop: vi.fn(),
    saveOpenShopEdit: vi.fn(),
    getPlan: vi.fn(),
  }
})

vi.mock('./store', () => ({
  useStore: {
    getState: () => mocks.appState,
    subscribe: vi.fn((listener: () => void) => {
      mocks.appSubscriber = listener
      return vi.fn()
    }),
  },
  updateTaskInStore: mocks.updateTask,
  getComposerDraftSnapshot: vi.fn(() => ({
    composerScope: 'tool',
    prompt: mocks.appState.prompt,
    inputImages: mocks.appState.inputImages,
    maskDraft: mocks.appState.maskDraft,
    params: mocks.appState.params,
    reusedTaskApiProfileId: null,
    reusedTaskApiProfileName: null,
    reusedTaskApiProfileMissing: false,
    composerVersion: mocks.appState.composerVersion,
  })),
  clearComposerDraft: mocks.clearComposerDraft,
  saveOpenShopEdit: mocks.saveOpenShopEdit,
}))
vi.mock('./lib/db', () => ({
  putTask: mocks.putTask,
  storeImage: vi.fn(),
  createOpenShopToolLocalRunRecord: mocks.createLocalRunRecord,
  claimOpenShopToolLocalRun: mocks.claimLocalRun,
  transitionOpenShopToolLocalRun: mocks.transitionLocalRun,
  storeOpenShopToolExport: mocks.storeLocalExport,
  getOpenShopToolLocalRun: mocks.getLocalRun,
  getOpenShopToolOutputDraft: mocks.getOutputDraft,
  getVerifiedCompletedOpenShopToolTask: mocks.getVerifiedCompletedTask,
  cleanupExpiredOpenShopToolOutputDrafts: mocks.cleanupDrafts,
}))
vi.mock('./lib/restrictedAgentApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/restrictedAgentApi')>()
  return {
    ...actual,
    createRestrictedAgentPlan: mocks.createPlan,
    executeRestrictedAgentPlan: mocks.executePlan,
    computeRestrictedAgentConfirmationHash: mocks.computeHash,
    getRestrictedAgentAsset: vi.fn(),
    getRestrictedAgentExecution: vi.fn(),
    getRestrictedAgentPlan: mocks.getPlan,
    cancelRestrictedAgentExecution: vi.fn(),
    subscribeRestrictedAgentExecution: vi.fn(() => vi.fn()),
  }
})
vi.mock('./lib/serverApiConfig', () => ({
  isRestrictedAgentEnabled: () => true,
}))
vi.mock('./lib/openShopToolRunner', () => ({
  openShopToolRunner: mocks.runOpenShop,
  OpenShopToolRunnerError: class OpenShopToolRunnerError extends Error {},
}))

import { decodePersistedAgentFlow, useRestrictedAgentStore } from './restrictedAgentStore'

const plan: RestrictedAgentPlan = {
  schemaVersion: 2,
  composerSnapshotHash: 'a'.repeat(64),
  id: '11111111-1111-4111-8111-111111111111',
  version: 1,
  status: 'awaiting_confirmation',
  expiresAt: '2099-01-01T00:00:00.000Z',
  originalRequest: '生成一张海报',
  summary: '海报计划',
  operation: {
    type: 'image.generate',
    generation: {
      exactPrompt: '完整海报提示词',
      action: 'generate',
      size: '1024x1024',
      quality: 'high',
      outputFormat: 'png',
      outputCompression: null,
      imageCount: 1,
    },
  },
  inputs: [],
  assumptions: [],
  warnings: [],
  policyVersion: 'tool-operation-v2',
}

const execution: RestrictedAgentExecution = {
  id: 'execution-1',
  planId: plan.id,
  status: 'completed',
  cancelRequested: false,
  error: null,
  outputAssets: [],
  createdAt: '2026-07-16T00:00:00.000Z',
  startedAt: '2026-07-16T00:00:01.000Z',
  completedAt: '2026-07-16T00:00:02.000Z',
  updatedAt: '2026-07-16T00:00:02.000Z',
}

const bindingPlan = {
  ...plan,
  operation: {
    type: 'image.edit',
    generation: {
      exactPrompt: '编辑两张参考图',
      action: 'edit',
      size: '1024x1024',
      quality: 'high',
      outputFormat: 'png',
      outputCompression: null,
      imageCount: 1,
    },
  },
  inputs: [
    { assetId: '33333333-3333-4333-8333-333333333333', role: 'reference', sha256: 'a'.repeat(64), mimeType: 'image/png', width: 1, height: 1 },
    { assetId: '44444444-4444-4444-8444-444444444444', role: 'reference', sha256: 'b'.repeat(64), mimeType: 'image/png', width: 1, height: 1 },
  ],
} as RestrictedAgentPlan

const validBindings = [
  { gatewayAssetId: bindingPlan.inputs[0]!.assetId, browserImageId: 'browser-1', sourceTaskId: 'task-1', role: 'reference' as const, ordinal: 0 },
  { gatewayAssetId: bindingPlan.inputs[1]!.assetId, browserImageId: 'browser-2', sourceTaskId: 'task-2', role: 'reference' as const, ordinal: 1 },
]

const openShopPlan = {
  ...plan,
  id: '77777777-7777-4777-8777-777777777777',
  originalRequest: '把图片旋转 90 度',
  summary: 'OpenShop 旋转计划',
  operation: {
    type: 'openshop.edit',
    inputAssetId: '88888888-8888-4888-8888-888888888888',
    commands: [{ schemaVersion: 1, id: 'canvas.rotate', target: 'document', args: { degrees: 90 } }],
    outputFormat: 'png',
  },
  inputs: [{
    assetId: '88888888-8888-4888-8888-888888888888', role: 'reference', sha256: 'e'.repeat(64),
    mimeType: 'image/png', width: 2, height: 1,
  }],
} as RestrictedAgentPlan

const openShopBindings = [{
  gatewayAssetId: '88888888-8888-4888-8888-888888888888',
  browserImageId: 'browser-source-image',
  sourceTaskId: 'source-task',
  role: 'reference' as const,
  ordinal: 0,
}]

function persistedFlow(assetBindings: unknown, persistedPlan: RestrictedAgentPlan = bindingPlan) {
  return {
    phase: 'awaiting_confirmation', plan: persistedPlan, execution: null, taskId: null, error: null,
    composerSnapshotVersion: 7, assetBindings,
  }
}

async function prepareExportedOpenShopRun() {
  mocks.appState.prompt = openShopPlan.originalRequest
  mocks.appState.inputImages = [{ id: 'browser-source-image', dataUrl: 'data:image/png;base64,c291cmNl' }]
  mocks.appState.tasks = [{
    id: 'source-task', prompt: 'source', params: mocks.appState.params, inputImageIds: [],
    outputImages: ['browser-source-image'], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1,
  }]
  mocks.computeHash.mockResolvedValue(openShopPlan.schemaVersion === 2 ? openShopPlan.composerSnapshotHash : null)
  mocks.getPlan.mockResolvedValue(openShopPlan)
  mocks.saveOpenShopEdit.mockRejectedValueOnce(new Error('initial save failed'))
  useRestrictedAgentStore.setState({
    phase: 'awaiting_confirmation', plan: openShopPlan, assetBindings: openShopBindings,
    composerSnapshotVersion: 7,
  })
  await useRestrictedAgentStore.getState().confirmAndExecute()
  if (!mocks.durableRun || mocks.durableRun.status !== 'exported') throw new Error('Expected exported OpenShop fixture')
  return mocks.durableRun
}

describe('restricted Agent flow store', () => {
  beforeEach(() => {
    mocks.appState.tasks = []
    mocks.appState.prompt = '生成一张海报'
    mocks.appState.inputImages = []
    mocks.appState.maskDraft = null
    mocks.appState.composerVersion = 7
    mocks.appState.settings.clearInputAfterSubmit = false
    mocks.appState.showToast.mockClear()
    mocks.appState.setTasks.mockClear()
    mocks.createPlan.mockReset().mockResolvedValue({ plan, assetBindings: [] })
    mocks.executePlan.mockReset().mockResolvedValue(execution)
    mocks.computeHash.mockReset().mockResolvedValue(plan.schemaVersion === 2 ? plan.composerSnapshotHash : null)
    mocks.putTask.mockReset().mockResolvedValue('agent-execution-1')
    mocks.updateTask.mockClear()
    mocks.clearComposerDraft.mockClear()
    mocks.durableRun = null
    mocks.outputDraft = null
    mocks.createLocalRunRecord.mockReset().mockImplementation(async (input: Omit<OpenShopToolLocalRun, 'schemaVersion' | 'identitySha256'>) => ({
      ...input,
      schemaVersion: 1,
      identitySha256: 'f'.repeat(64),
    }))
    mocks.claimLocalRun.mockReset().mockImplementation(async (candidate: OpenShopToolLocalRun) => {
      if (mocks.durableRun) return { run: mocks.durableRun, created: false }
      mocks.durableRun = structuredClone(candidate)
      return { run: mocks.durableRun, created: true }
    })
    mocks.transitionLocalRun.mockReset().mockImplementation(async (
      runId: string,
      expected: OpenShopToolLocalRun['status'][],
      patch: Partial<OpenShopToolLocalRun>,
    ) => {
      if (!mocks.durableRun || mocks.durableRun.id !== runId || !expected.includes(mocks.durableRun.status)) return null
      mocks.durableRun = { ...mocks.durableRun, ...patch, updatedAt: Date.now() }
      return mocks.durableRun
    })
    mocks.storeLocalExport.mockReset().mockImplementation(async (runId: string, draft: typeof mocks.outputDraft) => {
      if (!mocks.durableRun || mocks.durableRun.id !== runId || mocks.durableRun.status !== 'running') {
        throw new Error('invalid export transition')
      }
      mocks.outputDraft = draft
      const exportedAt = Date.now()
      mocks.durableRun = {
        ...mocks.durableRun,
        status: 'exported', saveStatus: 'pending', blobId: `mock-blob:${runId}`,
        error: null, errorStage: null, exportedAt, updatedAt: exportedAt,
      }
      return mocks.durableRun
    })
    mocks.getLocalRun.mockReset().mockImplementation(async () => mocks.durableRun)
    mocks.getOutputDraft.mockReset().mockImplementation(async () => mocks.outputDraft)
    mocks.getVerifiedCompletedTask.mockReset().mockImplementation(async (run: OpenShopToolLocalRun) => {
      const task = mocks.appState.tasks.find((item) => item.id === run.taskId)
      if (!task) throw new Error('completed task missing')
      return task
    })
    mocks.cleanupDrafts.mockReset().mockResolvedValue(undefined)
    mocks.runOpenShop.mockReset().mockResolvedValue({
      blob: new Blob(['png'], { type: 'image/png' }),
      filename: 'output.png',
      document: { canvas: { width: 1, height: 2 }, primaryImage: { present: true } },
    })
    mocks.saveOpenShopEdit.mockReset().mockImplementation(async (options: { completeToolRun: { run: OpenShopToolLocalRun }; taskId: string }) => {
      mocks.durableRun = options.completeToolRun.run
      mocks.outputDraft = null
      const existing = mocks.appState.tasks.find((task) => task.id === options.taskId)
      const done = {
        ...(existing ?? {
          id: options.taskId, prompt: 'OpenShop', params: mocks.appState.params, inputImageIds: ['browser-source-image'],
          createdAt: 1,
        }),
        outputImages: ['output-image'], status: 'done' as const, error: null, finishedAt: 2, elapsed: 1,
        origin: 'restricted-agent' as const, agentLocalRunStatus: 'completed' as const,
      }
      mocks.appState.tasks = [done, ...mocks.appState.tasks.filter((task) => task.id !== done.id)]
      return done
    })
    mocks.getPlan.mockReset().mockResolvedValue(plan)
    useRestrictedAgentStore.setState({
      phase: 'idle',
      plan: null,
      execution: null,
      taskId: null,
      error: null,
      composerSnapshotVersion: null,
      assetBindings: [],
      localRunId: null,
      localRun: null,
    })
  })

  it('规划阶段不创建历史任务，并保存服务端计划与本地binding', async () => {
    await useRestrictedAgentStore.getState().createPlanFromCurrentInput()

    expect(useRestrictedAgentStore.getState().phase).toBe('awaiting_confirmation')
    expect(mocks.createPlan).toHaveBeenCalledOnce()
    expect(mocks.appState.setTasks).not.toHaveBeenCalled()
    expect(mocks.putTask).not.toHaveBeenCalled()
  })

  it('将当前页面的联网开关作为单次 Tool 规划参数传递', async () => {
    await useRestrictedAgentStore.getState().createPlanFromCurrentInput(undefined, true)

    expect(mocks.createPlan).toHaveBeenCalledWith(expect.objectContaining({ webSearchEnabled: true }))
  })

  it('从显式 Tool Composer 快照构造完整规范输入', async () => {
    mocks.appState.tasks = [{
      id: 'source-task', prompt: 'source', params: mocks.appState.params, inputImageIds: [], outputImages: ['tool-image'],
      status: 'done', error: null, createdAt: 0, finishedAt: 1, elapsed: 1,
    }]
    const snapshot = {
      composerScope: 'tool' as const,
      prompt: ' Tool 独立需求 ',
      inputImages: [{ id: 'tool-image', dataUrl: 'data:image/png;base64,dG9vbA==' }],
      maskDraft: null,
      params: { ...mocks.appState.params, quality: 'medium' as const },
      reusedTaskApiProfileId: 'profile-1',
      reusedTaskApiProfileName: '临时 Profile',
      reusedTaskApiProfileMissing: false,
      composerVersion: 11,
    }

    await useRestrictedAgentStore.getState().createPlanFromCurrentInput(snapshot)

    expect(mocks.createPlan).toHaveBeenCalledWith(expect.objectContaining({
      request: 'Tool 独立需求',
      quality: 'medium',
      moderation: 'auto',
      webSearchEnabled: false,
      inputs: [{
        role: 'reference', browserImageId: 'tool-image', sourceTaskId: 'source-task',
        dataUrl: 'data:image/png;base64,dG9vbA==',
      }],
      temporaryProfile: { id: 'profile-1', name: '临时 Profile', missing: false },
    }))
    expect(useRestrictedAgentStore.getState().composerSnapshotVersion).toBe(11)
  })

  it('只在当前hash通过最终门禁后确认并创建标准任务', async () => {
    mocks.appState.settings.clearInputAfterSubmit = true
    useRestrictedAgentStore.setState({
      phase: 'awaiting_confirmation', plan, composerSnapshotVersion: 7, assetBindings: [],
    })

    const taskId = await useRestrictedAgentStore.getState().confirmAndExecute()

    expect(taskId).toBe('agent-execution-1')
    expect(mocks.computeHash).toHaveBeenCalledOnce()
    expect(mocks.executePlan).toHaveBeenCalledWith(plan, plan.schemaVersion === 2 ? plan.composerSnapshotHash : null)
    expect(mocks.appState.setTasks).toHaveBeenCalledOnce()
    expect(mocks.putTask).toHaveBeenCalledWith(expect.objectContaining({
      id: 'agent-execution-1',
      origin: 'restricted-agent',
      agentPlanId: plan.id,
      agentExecutionId: execution.id,
      prompt: plan.operation.type === 'image.generate' ? plan.operation.generation.exactPrompt : '',
    }))
    expect(mocks.clearComposerDraft).toHaveBeenCalledWith('tool', 7, true)
  })

  it('当前hash不匹配时标记stale且不调用确认API', async () => {
    mocks.computeHash.mockResolvedValue(null)
    useRestrictedAgentStore.setState({
      phase: 'awaiting_confirmation', plan, composerSnapshotVersion: 7, assetBindings: [],
    })

    await useRestrictedAgentStore.getState().confirmAndExecute()

    expect(useRestrictedAgentStore.getState().phase).toBe('stale')
    expect(mocks.executePlan).not.toHaveBeenCalled()
  })

  it('Composer改动后stale，完全改回原语义后恢复awaiting_confirmation', async () => {
    useRestrictedAgentStore.setState({
      phase: 'awaiting_confirmation', plan, composerSnapshotVersion: 7, assetBindings: [],
    })
    mocks.computeHash.mockResolvedValueOnce(null).mockResolvedValueOnce(plan.schemaVersion === 2 ? plan.composerSnapshotHash : null)

    mocks.appState.composerVersion = 8
    mocks.appSubscriber?.()
    await vi.waitFor(() => expect(useRestrictedAgentStore.getState().phase).toBe('stale'))

    mocks.appState.composerVersion = 9
    mocks.appSubscriber?.()
    await vi.waitFor(() => expect(useRestrictedAgentStore.getState().phase).toBe('awaiting_confirmation'))
    expect(useRestrictedAgentStore.getState().error).toBeNull()
  })

  it('rehydrate 对缺失、role/ordinal错序及重复绑定 fail-closed，并且不发确认请求', async () => {
    const invalidBindings = [
      undefined,
      validBindings.slice(0, 1),
      [validBindings[1], validBindings[0]],
      [validBindings[0], { ...validBindings[1]!, role: 'mask_target' as const }],
      [validBindings[0], { ...validBindings[1]!, ordinal: 0 }],
      [validBindings[0], { ...validBindings[1]!, gatewayAssetId: validBindings[0]!.gatewayAssetId }],
      [validBindings[0], { ...validBindings[1]!, browserImageId: validBindings[0]!.browserImageId }],
    ]
    for (const bindings of invalidBindings) {
      const restored = decodePersistedAgentFlow(persistedFlow(bindings), Date.parse('2026-01-01T00:00:00.000Z'))
      expect(restored.phase).toBe('stale')
      expect(restored.error).toContain('binding')
      useRestrictedAgentStore.setState(restored)
      await useRestrictedAgentStore.getState().confirmAndExecute()
    }
    expect(mocks.executePlan).not.toHaveBeenCalled()
  })

  it('rehydrate 正常 binding 可确认，Composer 改动后再改回可恢复', async () => {
    const restored = decodePersistedAgentFlow(persistedFlow(validBindings), Date.parse('2026-01-01T00:00:00.000Z'))
    expect(restored.phase).toBe('awaiting_confirmation')
    expect(restored.assetBindings).toEqual(validBindings)
    useRestrictedAgentStore.setState(restored)

    await useRestrictedAgentStore.getState().confirmAndExecute()
    expect(mocks.executePlan).toHaveBeenCalledOnce()

    mocks.executePlan.mockClear()
    useRestrictedAgentStore.setState(restored)
    mocks.computeHash.mockResolvedValueOnce(null).mockResolvedValueOnce(bindingPlan.composerSnapshotHash)
    mocks.appState.composerVersion = 8
    mocks.appSubscriber?.()
    await vi.waitFor(() => expect(useRestrictedAgentStore.getState().phase).toBe('stale'))
    mocks.appState.composerVersion = 9
    mocks.appSubscriber?.()
    await vi.waitFor(() => expect(useRestrictedAgentStore.getState().phase).toBe('awaiting_confirmation'))
    expect(mocks.executePlan).not.toHaveBeenCalled()
  })

  it('rehydrate 拒绝带 sourceTaskId 的 mask binding，保持 stale 且不发确认', async () => {
    const maskPlan = {
      ...bindingPlan,
      operation: {
        type: 'image.edit',
        generation: {
          exactPrompt: '局部编辑', action: 'edit', size: '1024x1024', quality: 'high',
          outputFormat: 'png', outputCompression: null, imageCount: 1,
        },
      },
      inputs: [
        { assetId: '55555555-5555-4555-8555-555555555555', role: 'mask_target', sha256: 'c'.repeat(64), mimeType: 'image/png', width: 1, height: 1 },
        { assetId: '66666666-6666-4666-8666-666666666666', role: 'mask', sha256: 'd'.repeat(64), mimeType: 'image/png', width: 1, height: 1 },
      ],
    } as RestrictedAgentPlan
    const tamperedBindings = [
      { gatewayAssetId: maskPlan.inputs[0]!.assetId, browserImageId: 'mask-target', sourceTaskId: 'task-mask-target', role: 'mask_target' as const, ordinal: 0 },
      { gatewayAssetId: maskPlan.inputs[1]!.assetId, browserImageId: null, sourceTaskId: 'tampered-source-task', role: 'mask' as const, ordinal: 0 },
    ]
    const restored = decodePersistedAgentFlow(
      persistedFlow(tamperedBindings, maskPlan),
      Date.parse('2026-01-01T00:00:00.000Z'),
    )
    expect(restored.phase).toBe('stale')
    expect(restored.error).toContain('binding')
    useRestrictedAgentStore.setState(restored)

    await useRestrictedAgentStore.getState().confirmAndExecute()

    expect(mocks.executePlan).not.toHaveBeenCalled()
  })

  it('OpenShop 双击确认复用同一 Local Run，且不调用 Gateway execute', async () => {
    mocks.appState.prompt = openShopPlan.originalRequest
    mocks.appState.inputImages = [{ id: 'browser-source-image', dataUrl: 'data:image/png;base64,c291cmNl' }]
    mocks.appState.tasks = [{
      id: 'source-task', prompt: 'source', params: mocks.appState.params, inputImageIds: [],
      outputImages: ['browser-source-image'], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1,
    }]
    mocks.computeHash.mockResolvedValue(openShopPlan.schemaVersion === 2 ? openShopPlan.composerSnapshotHash : null)
    mocks.getPlan.mockResolvedValue(openShopPlan)
    useRestrictedAgentStore.setState({
      phase: 'awaiting_confirmation', plan: openShopPlan, assetBindings: openShopBindings,
      composerSnapshotVersion: 7,
    })

    const first = useRestrictedAgentStore.getState().confirmAndExecute()
    const second = useRestrictedAgentStore.getState().confirmAndExecute()
    const [firstTaskId, secondTaskId] = await Promise.all([first, second])

    expect(firstTaskId).toBe(secondTaskId)
    expect(mocks.claimLocalRun).toHaveBeenCalledOnce()
    expect(mocks.runOpenShop).toHaveBeenCalledOnce()
    expect(mocks.saveOpenShopEdit).toHaveBeenCalledOnce()
    expect(mocks.executePlan).not.toHaveBeenCalled()
    expect(useRestrictedAgentStore.getState().localRun?.status).toBe('completed')
  })

  it('OpenShop 保存失败保留 exported Blob，重试保存不重新创建 iframe', async () => {
    mocks.appState.prompt = openShopPlan.originalRequest
    mocks.appState.inputImages = [{ id: 'browser-source-image', dataUrl: 'data:image/png;base64,c291cmNl' }]
    mocks.appState.tasks = [{
      id: 'source-task', prompt: 'source', params: mocks.appState.params, inputImageIds: [],
      outputImages: ['browser-source-image'], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1,
    }]
    mocks.computeHash.mockResolvedValue(openShopPlan.schemaVersion === 2 ? openShopPlan.composerSnapshotHash : null)
    mocks.getPlan.mockResolvedValue(openShopPlan)
    mocks.saveOpenShopEdit.mockRejectedValueOnce(new Error('quota exceeded'))
    useRestrictedAgentStore.setState({
      phase: 'awaiting_confirmation', plan: openShopPlan, assetBindings: openShopBindings,
      composerSnapshotVersion: 7,
    })

    await useRestrictedAgentStore.getState().confirmAndExecute()
    expect(useRestrictedAgentStore.getState().localRun?.status).toBe('exported')
    expect(mocks.outputDraft?.blob).toBeInstanceOf(Blob)

    const taskId = await useRestrictedAgentStore.getState().retryOpenShopSave()

    expect(taskId).toContain('agent-openshop-')
    expect(mocks.runOpenShop).toHaveBeenCalledOnce()
    expect(mocks.saveOpenShopEdit).toHaveBeenCalledTimes(2)
    expect(useRestrictedAgentStore.getState().localRun?.status).toBe('completed')
  })

  it('两个快速 retry 复用同一 Promise，只执行一次 CAS 和一次 save', async () => {
    const exported = await prepareExportedOpenShopRun()
    const transitionCalls = mocks.transitionLocalRun.mock.calls.length
    const saveCalls = mocks.saveOpenShopEdit.mock.calls.length

    const first = useRestrictedAgentStore.getState().retryOpenShopSave()
    const second = useRestrictedAgentStore.getState().retryOpenShopSave()

    expect(second).toBe(first)
    await expect(Promise.all([first, second])).resolves.toEqual([exported.taskId, exported.taskId])
    expect(mocks.transitionLocalRun).toHaveBeenCalledTimes(transitionCalls + 1)
    expect(mocks.saveOpenShopEdit).toHaveBeenCalledTimes(saveCalls + 1)
    expect(useRestrictedAgentStore.getState().localRun).toMatchObject({ status: 'completed', saveStatus: 'completed' })
  })

  it('并发 retry 后立即 cancel 会中止唯一胜出 attempt，回滚 exported 并保留 Blob', async () => {
    await prepareExportedOpenShopRun()
    const transitionCalls = mocks.transitionLocalRun.mock.calls.length
    const saveCalls = mocks.saveOpenShopEdit.mock.calls.length
    mocks.saveOpenShopEdit.mockImplementationOnce(() => new Promise<TaskRecord>(() => {}))

    const first = useRestrictedAgentStore.getState().retryOpenShopSave({ timeoutMs: 60_000 })
    const second = useRestrictedAgentStore.getState().retryOpenShopSave({ timeoutMs: 60_000 })
    expect(second).toBe(first)
    await useRestrictedAgentStore.getState().cancelExecution()
    await expect(Promise.all([first, second])).resolves.toEqual([null, null])

    expect(mocks.transitionLocalRun).toHaveBeenCalledTimes(transitionCalls + 2)
    expect(mocks.saveOpenShopEdit).toHaveBeenCalledTimes(saveCalls + 1)
    expect(mocks.durableRun).toMatchObject({ status: 'exported', saveStatus: 'failed' })
    expect(mocks.outputDraft?.blob).toBeInstanceOf(Blob)
  })

  it('自动保存 pending 时手动 retry 复用同一 attempt，取消及完成后均清理锁', async () => {
    const NativeAbortController = globalThis.AbortController
    const controllers: AbortController[] = []
    const AbortControllerMock = vi.fn(function AbortControllerMock() {
      const controller = new NativeAbortController()
      controllers.push(controller)
      return controller
    })
    vi.stubGlobal('AbortController', AbortControllerMock)
    try {
      mocks.appState.prompt = openShopPlan.originalRequest
      mocks.appState.inputImages = [{ id: 'browser-source-image', dataUrl: 'data:image/png;base64,c291cmNl' }]
      mocks.appState.tasks = [{
        id: 'source-task', prompt: 'source', params: mocks.appState.params, inputImageIds: [],
        outputImages: ['browser-source-image'], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1,
      }]
      mocks.computeHash.mockResolvedValue(openShopPlan.schemaVersion === 2 ? openShopPlan.composerSnapshotHash : null)
      mocks.getPlan.mockResolvedValue(openShopPlan)
      mocks.saveOpenShopEdit.mockImplementationOnce(() => new Promise<TaskRecord>(() => {}))
      useRestrictedAgentStore.setState({
        phase: 'awaiting_confirmation', plan: openShopPlan, assetBindings: openShopBindings,
        composerSnapshotVersion: 7,
      })

      const automatic = useRestrictedAgentStore.getState().confirmAndExecute()
      await vi.waitFor(() => expect(useRestrictedAgentStore.getState().localRun?.status).toBe('saving'))
      const transitionCalls = mocks.transitionLocalRun.mock.calls.length
      const saveCalls = mocks.saveOpenShopEdit.mock.calls.length
      const firstRetry = useRestrictedAgentStore.getState().retryOpenShopSave({ timeoutMs: 60_000 })
      const secondRetry = useRestrictedAgentStore.getState().retryOpenShopSave({ timeoutMs: 60_000 })

      expect(secondRetry).toBe(firstRetry)
      expect(mocks.transitionLocalRun).toHaveBeenCalledTimes(transitionCalls)
      expect(mocks.saveOpenShopEdit).toHaveBeenCalledTimes(saveCalls)
      expect(AbortControllerMock).toHaveBeenCalledOnce()

      await useRestrictedAgentStore.getState().cancelExecution()
      await expect(Promise.all([automatic, firstRetry, secondRetry])).resolves.toEqual([null, null, null])
      expect(controllers[0]?.signal.aborted).toBe(true)
      expect(mocks.durableRun).toMatchObject({ status: 'exported', saveStatus: 'failed' })
      expect(mocks.outputDraft?.blob).toBeInstanceOf(Blob)

      const completedAttempt = useRestrictedAgentStore.getState().retryOpenShopSave()
      expect(completedAttempt).not.toBe(firstRetry)
      await expect(completedAttempt).resolves.toContain('agent-openshop-')
      expect(AbortControllerMock).toHaveBeenCalledTimes(2)

      const afterCompletion = useRestrictedAgentStore.getState().retryOpenShopSave()
      expect(afterCompletion).not.toBe(completedAttempt)
      await expect(afterCompletion).resolves.toContain('agent-openshop-')
      expect(AbortControllerMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.stubGlobal('AbortController', NativeAbortController)
    }
  })

  it('失败 attempt 清理 retry 锁，后续调用可创建新 attempt 并完成', async () => {
    const exported = await prepareExportedOpenShopRun()
    mocks.saveOpenShopEdit.mockRejectedValueOnce(new Error('retry failed once'))

    const failed = useRestrictedAgentStore.getState().retryOpenShopSave()
    await expect(failed).resolves.toBeNull()
    expect(mocks.durableRun?.status).toBe('exported')

    const retried = useRestrictedAgentStore.getState().retryOpenShopSave()
    expect(retried).not.toBe(failed)
    await expect(retried).resolves.toBe(exported.taskId)
    expect(mocks.durableRun).toMatchObject({ status: 'completed', saveStatus: 'completed' })
  })

  it('重复确认 completed Run 必须先验证 durable Task，缺失证据时不创建 running Task', async () => {
    const exported = await prepareExportedOpenShopRun()
    await useRestrictedAgentStore.getState().retryOpenShopSave()
    const putCalls = mocks.putTask.mock.calls.length
    mocks.getVerifiedCompletedTask.mockRejectedValueOnce(new Error('completed task missing'))
    mocks.appState.prompt = openShopPlan.originalRequest
    mocks.appState.inputImages = [{ id: 'browser-source-image', dataUrl: 'data:image/png;base64,c291cmNl' }]
    useRestrictedAgentStore.setState({
      phase: 'awaiting_confirmation', plan: openShopPlan, assetBindings: openShopBindings,
      composerSnapshotVersion: 7, localRun: null, localRunId: null, taskId: null,
    })

    await expect(useRestrictedAgentStore.getState().confirmAndExecute()).resolves.toBeNull()

    expect(mocks.putTask).toHaveBeenCalledTimes(putCalls)
    expect(useRestrictedAgentStore.getState()).toMatchObject({ phase: 'failed', error: 'completed task missing' })
    expect(mocks.durableRun).toMatchObject({ id: exported.id, status: 'completed' })
  })

  it('重复确认 completed Run 在 Task 证据有效时复用最终 Task，不创建 running Task', async () => {
    const exported = await prepareExportedOpenShopRun()
    await useRestrictedAgentStore.getState().retryOpenShopSave()
    const putCalls = mocks.putTask.mock.calls.length
    const evidenceCalls = mocks.getVerifiedCompletedTask.mock.calls.length
    mocks.appState.prompt = openShopPlan.originalRequest
    mocks.appState.inputImages = [{ id: 'browser-source-image', dataUrl: 'data:image/png;base64,c291cmNl' }]
    useRestrictedAgentStore.setState({
      phase: 'awaiting_confirmation', plan: openShopPlan, assetBindings: openShopBindings,
      composerSnapshotVersion: 7, localRun: null, localRunId: null, taskId: null,
    })

    await expect(useRestrictedAgentStore.getState().confirmAndExecute()).resolves.toBe(exported.taskId)

    expect(mocks.getVerifiedCompletedTask.mock.calls.length).toBe(evidenceCalls + 1)
    expect(mocks.putTask).toHaveBeenCalledTimes(putCalls)
    expect(useRestrictedAgentStore.getState()).toMatchObject({ phase: 'completed', taskId: exported.taskId })
  })

  it('OpenShop 保存 deadline 到期后 saving 回滚 exported、保留 Blob，迟到完成不能改成 completed', async () => {
    const exported = await prepareExportedOpenShopRun()
    vi.useFakeTimers()
    let resolveLate!: (task: TaskRecord) => void
    mocks.saveOpenShopEdit.mockImplementationOnce(() => new Promise<TaskRecord>((resolve) => { resolveLate = resolve }))

    const retry = useRestrictedAgentStore.getState().retryOpenShopSave({ timeoutMs: 20 })
    for (let index = 0; index < 8 && useRestrictedAgentStore.getState().localRun?.status !== 'saving'; index += 1) await Promise.resolve()
    expect(useRestrictedAgentStore.getState().localRun?.status).toBe('saving')
    await vi.advanceTimersByTimeAsync(20)
    await expect(retry).resolves.toBeNull()

    expect(mocks.durableRun).toMatchObject({ id: exported.id, status: 'exported', saveStatus: 'failed' })
    expect(mocks.outputDraft?.blob).toBeInstanceOf(Blob)
    expect(useRestrictedAgentStore.getState().localRun?.status).toBe('exported')
    resolveLate({
      id: exported.taskId, prompt: 'late', params: mocks.appState.params, inputImageIds: [exported.inputImageId],
      outputImages: ['late-image'], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1,
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.durableRun?.status).toBe('exported')
    expect(useRestrictedAgentStore.getState().localRun?.status).toBe('exported')
  })

  it('OpenShop 保存 deadline 从 CAS 前开始，hung transition 超时后 UI 仍为 exported', async () => {
    const exported = await prepareExportedOpenShopRun()
    vi.useFakeTimers()
    mocks.transitionLocalRun.mockImplementationOnce((
      _runId: string,
      _expected: OpenShopToolLocalRun['status'][],
      _patch: Partial<OpenShopToolLocalRun>,
      signal?: AbortSignal,
    ) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))

    const retry = useRestrictedAgentStore.getState().retryOpenShopSave({ timeoutMs: 20 })
    for (let index = 0; index < 8 && mocks.transitionLocalRun.mock.calls.length < 4; index += 1) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(20)
    await expect(retry).resolves.toBeNull()

    expect(mocks.durableRun).toMatchObject({ id: exported.id, status: 'exported' })
    expect(mocks.outputDraft?.blob).toBeInstanceOf(Blob)
    expect(useRestrictedAgentStore.getState().phase).toBe('failed')
    expect(useRestrictedAgentStore.getState().localRun).toMatchObject({ id: exported.id, status: 'exported' })
  })

  it('用户取消 saving 时回滚 exported 并保留可重试 Blob', async () => {
    await prepareExportedOpenShopRun()
    mocks.saveOpenShopEdit.mockImplementationOnce(() => new Promise<TaskRecord>(() => {}))

    const retry = useRestrictedAgentStore.getState().retryOpenShopSave({ timeoutMs: 60_000 })
    await vi.waitFor(() => expect(useRestrictedAgentStore.getState().localRun?.status).toBe('saving'))
    await useRestrictedAgentStore.getState().cancelExecution()
    await expect(retry).resolves.toBeNull()

    expect(mocks.durableRun).toMatchObject({ status: 'exported', saveStatus: 'failed' })
    expect(mocks.outputDraft?.blob).toBeInstanceOf(Blob)
    expect(useRestrictedAgentStore.getState().localRun?.status).toBe('exported')
  })

  it('保存失败与 TTL cleanup 并发时以 durable expired 状态同步 UI', async () => {
    const exported = await prepareExportedOpenShopRun()
    let rejectSave!: (error: Error) => void
    mocks.saveOpenShopEdit.mockImplementationOnce(() => new Promise<TaskRecord>((_resolve, reject) => { rejectSave = reject }))

    const retry = useRestrictedAgentStore.getState().retryOpenShopSave({ timeoutMs: 60_000 })
    await vi.waitFor(() => expect(useRestrictedAgentStore.getState().localRun?.status).toBe('saving'))
    mocks.durableRun = {
      ...exported,
      status: 'expired',
      saveStatus: 'failed',
      blobId: null,
      error: { code: 'OUTPUT_DRAFT_EXPIRED', message: 'OpenShop 临时导出结果已过期，请重新规划', retryable: false },
      errorStage: 'expiry',
      completedAt: null,
    }
    mocks.outputDraft = null
    rejectSave(new Error('save lost cleanup race'))
    await expect(retry).resolves.toBeNull()

    expect(useRestrictedAgentStore.getState()).toMatchObject({ phase: 'expired' })
    expect(useRestrictedAgentStore.getState().localRun).toMatchObject({ status: 'expired', saveStatus: 'failed' })
  })

  it('重试已过期 durable Run 时同步 expired UI 且不进入保存', async () => {
    const exported = await prepareExportedOpenShopRun()
    const saveCalls = mocks.saveOpenShopEdit.mock.calls.length
    mocks.durableRun = {
      ...exported,
      status: 'expired',
      saveStatus: 'failed',
      blobId: null,
      error: { code: 'OUTPUT_DRAFT_EXPIRED', message: 'OpenShop 临时导出结果已过期，请重新规划', retryable: false },
      errorStage: 'expiry',
      completedAt: null,
    }

    await expect(useRestrictedAgentStore.getState().retryOpenShopSave()).resolves.toBeNull()

    expect(mocks.saveOpenShopEdit).toHaveBeenCalledTimes(saveCalls)
    expect(useRestrictedAgentStore.getState()).toMatchObject({ phase: 'expired' })
    expect(useRestrictedAgentStore.getState().localRun).toMatchObject({ status: 'expired' })
  })

  it('recover 遇到 cleanup 持久化错误时 fail-closed，不猜测 Local Run', async () => {
    mocks.cleanupDrafts.mockRejectedValueOnce(new Error('damaged draft schema'))
    useRestrictedAgentStore.setState({ phase: 'executing', localRunId: 'damaged-run', localRun: null })

    await useRestrictedAgentStore.getState().recover([])

    expect(useRestrictedAgentStore.getState()).toMatchObject({ phase: 'failed', localRun: null, error: 'damaged draft schema' })
    expect(mocks.getLocalRun).not.toHaveBeenCalled()
  })

  it('OpenShop sourceTaskId 与 browserImageId 不匹配时在 claim 前 fail closed', async () => {
    mocks.appState.prompt = openShopPlan.originalRequest
    mocks.appState.inputImages = [{ id: 'browser-source-image', dataUrl: 'data:image/png;base64,c291cmNl' }]
    mocks.appState.tasks = [{
      id: 'source-task', prompt: 'source', params: mocks.appState.params, inputImageIds: [],
      outputImages: ['different-image'], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1,
    }]
    useRestrictedAgentStore.setState({
      phase: 'awaiting_confirmation', plan: openShopPlan, assetBindings: openShopBindings,
      composerSnapshotVersion: 7,
    })

    await useRestrictedAgentStore.getState().confirmAndExecute()

    expect(useRestrictedAgentStore.getState().phase).toBe('stale')
    expect(mocks.claimLocalRun).not.toHaveBeenCalled()
    expect(mocks.runOpenShop).not.toHaveBeenCalled()
  })

  it('刷新恢复 running Local Run 时标记 interrupted，绝不自动调用 Runner', async () => {
    const now = Date.now()
    const durableRun: OpenShopToolLocalRun = {
      schemaVersion: 1,
      id: `openshop:${openShopPlan.id}:1:${'a'.repeat(64)}`,
      idempotencyKey: `openshop:${openShopPlan.id}:1:${'a'.repeat(64)}`,
      identitySha256: 'f'.repeat(64),
      taskId: 'agent-openshop-recover', planId: openShopPlan.id, planVersion: 1,
      composerSnapshotHash: 'a'.repeat(64), composerSnapshotVersion: 7,
      planSnapshot: openShopPlan as Extract<RestrictedAgentPlan, { schemaVersion: 2 }>,
      sourceTaskId: null, inputImageId: 'browser-source-image', taskParams: mocks.appState.params,
      inputBinding: {
        gatewayAssetId: openShopBindings[0]!.gatewayAssetId,
        browserImageId: 'browser-source-image',
        sourceTaskId: null,
        role: 'reference',
        ordinal: 0,
      },
      commands: openShopPlan.schemaVersion === 2 && openShopPlan.operation.type === 'openshop.edit'
        ? openShopPlan.operation.commands : [],
      outputFormat: 'png', blobId: null, status: 'running', saveStatus: 'not_started', error: null,
      errorStage: null,
      createdAt: now, startedAt: now, exportedAt: null, updatedAt: now, completedAt: null,
    }
    mocks.durableRun = durableRun
    useRestrictedAgentStore.setState({
      phase: 'executing', plan: openShopPlan, localRunId: durableRun.id,
      localRun: null, taskId: durableRun.taskId,
    })

    await Promise.all([
      useRestrictedAgentStore.getState().recover([]),
      useRestrictedAgentStore.getState().recover([]),
    ])

    expect(useRestrictedAgentStore.getState().localRun?.status).toBe('interrupted')
    expect(mocks.runOpenShop).not.toHaveBeenCalled()
  })
})

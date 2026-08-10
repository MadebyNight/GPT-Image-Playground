import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RestrictedAgentExecution, RestrictedAgentPlan, TaskRecord } from './types'

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
}))
vi.mock('./lib/db', () => ({
  putTask: mocks.putTask,
  storeImage: vi.fn(),
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
    cancelRestrictedAgentExecution: vi.fn(),
    subscribeRestrictedAgentExecution: vi.fn(() => vi.fn()),
  }
})
vi.mock('./lib/serverApiConfig', () => ({
  isRestrictedAgentEnabled: () => true,
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

function persistedFlow(assetBindings: unknown, persistedPlan: RestrictedAgentPlan = bindingPlan) {
  return {
    phase: 'awaiting_confirmation', plan: persistedPlan, execution: null, taskId: null, error: null,
    composerSnapshotVersion: 7, assetBindings,
  }
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
    useRestrictedAgentStore.setState({
      phase: 'idle',
      plan: null,
      execution: null,
      taskId: null,
      error: null,
      composerSnapshotVersion: null,
      assetBindings: [],
    })
  })

  it('规划阶段不创建历史任务，并保存服务端计划与本地binding', async () => {
    await useRestrictedAgentStore.getState().createPlanFromCurrentInput()

    expect(useRestrictedAgentStore.getState().phase).toBe('awaiting_confirmation')
    expect(mocks.createPlan).toHaveBeenCalledOnce()
    expect(mocks.appState.setTasks).not.toHaveBeenCalled()
    expect(mocks.putTask).not.toHaveBeenCalled()
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
})

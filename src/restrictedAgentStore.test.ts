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
    maskDraft: null,
    tasks: [] as TaskRecord[],
    settings: { clearInputAfterSubmit: false },
    showToast: vi.fn(),
    setTasks: vi.fn((tasks: TaskRecord[]) => { appState.tasks = tasks }),
    setPrompt: vi.fn(),
    clearInputImages: vi.fn(),
    clearMaskDraft: vi.fn(),
  }
  return {
    appState,
    createPlan: vi.fn(),
    executePlan: vi.fn(),
    putTask: vi.fn(),
    updateTask: vi.fn(),
    clearComposerDraft: vi.fn(),
  }
})

vi.mock('./store', () => ({
  useStore: { getState: () => mocks.appState },
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
    composerVersion: 7,
  })),
  clearComposerDraft: mocks.clearComposerDraft,
}))
vi.mock('./lib/db', () => ({
  putTask: mocks.putTask,
  storeImage: vi.fn(),
}))
vi.mock('./lib/restrictedAgentApi', () => ({
  createRestrictedAgentPlan: mocks.createPlan,
  executeRestrictedAgentPlan: mocks.executePlan,
  getRestrictedAgentAsset: vi.fn(),
  getRestrictedAgentExecution: vi.fn(),
  cancelRestrictedAgentExecution: vi.fn(),
  subscribeRestrictedAgentExecution: vi.fn(() => vi.fn()),
}))
vi.mock('./lib/serverApiConfig', () => ({
  isRestrictedAgentEnabled: () => true,
}))

import { useRestrictedAgentStore } from './restrictedAgentStore'

const plan: RestrictedAgentPlan = {
  id: 'plan-1',
  version: 1,
  status: 'awaiting_confirmation',
  expiresAt: '2099-01-01T00:00:00.000Z',
  originalRequest: '生成一张海报',
  summary: '海报计划',
  steps: [{ title: '生成海报', operation: 'generate' }],
  generation: {
    exactPrompt: '完整海报提示词',
    action: 'generate',
    size: '1024x1024',
    quality: 'high',
    outputFormat: 'png',
    outputCompression: null,
    imageCount: 1,
  },
  inputs: [],
  assumptions: [],
  warnings: [],
  policyVersion: 'v1',
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

describe('restricted Agent flow store', () => {
  beforeEach(() => {
    mocks.appState.tasks = []
    mocks.appState.prompt = '生成一张海报'
    mocks.appState.inputImages = []
    mocks.appState.maskDraft = null
    mocks.appState.settings.clearInputAfterSubmit = false
    mocks.appState.showToast.mockClear()
    mocks.appState.setTasks.mockClear()
    mocks.createPlan.mockReset().mockResolvedValue(plan)
    mocks.executePlan.mockReset().mockResolvedValue(execution)
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
    })
  })

  it('does not create a history task while only planning', async () => {
    await useRestrictedAgentStore.getState().createPlanFromCurrentInput()

    expect(useRestrictedAgentStore.getState().phase).toBe('awaiting_confirmation')
    expect(mocks.createPlan).toHaveBeenCalledOnce()
    expect(mocks.appState.setTasks).not.toHaveBeenCalled()
    expect(mocks.putTask).not.toHaveBeenCalled()
  })

  it('plans from the explicit Tool composer snapshot instead of the currently visible mode', async () => {
    const snapshot = {
      composerScope: 'tool' as const,
      prompt: 'Tool 独立需求',
      inputImages: [{ id: 'tool-image', dataUrl: 'data:image/png;base64,tool' }],
      maskDraft: null,
      params: { ...mocks.appState.params, quality: 'medium' as const },
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      composerVersion: 11,
    }

    await useRestrictedAgentStore.getState().createPlanFromCurrentInput(snapshot)

    expect(mocks.createPlan).toHaveBeenCalledWith(expect.objectContaining({
      request: 'Tool 独立需求',
      quality: 'medium',
      references: [{ dataUrl: 'data:image/png;base64,tool' }],
    }))
    expect(useRestrictedAgentStore.getState().composerSnapshotVersion).toBe(11)
  })

  it('creates the standard task only after execute accepts the frozen plan', async () => {
    mocks.appState.settings.clearInputAfterSubmit = true
    useRestrictedAgentStore.setState({ phase: 'awaiting_confirmation', plan, composerSnapshotVersion: 7 })

    const taskId = await useRestrictedAgentStore.getState().confirmAndExecute()

    expect(taskId).toBe('agent-execution-1')
    expect(mocks.executePlan).toHaveBeenCalledWith(plan)
    expect(mocks.appState.setTasks).toHaveBeenCalledOnce()
    expect(mocks.putTask).toHaveBeenCalledWith(expect.objectContaining({
      id: 'agent-execution-1',
      origin: 'restricted-agent',
      agentPlanId: plan.id,
      agentExecutionId: execution.id,
      prompt: plan.generation.exactPrompt,
    }))
    expect(mocks.clearComposerDraft).toHaveBeenCalledWith('tool', 7, true)
  })
})

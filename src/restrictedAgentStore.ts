import { create } from 'zustand'
import { putTask, storeImage } from './lib/db'
import {
  cancelRestrictedAgentExecution,
  computeRestrictedAgentConfirmationHash,
  createRestrictedAgentPlan,
  decodeRestrictedAgentAssetBindings,
  decodeRestrictedAgentPlan,
  executeRestrictedAgentPlan,
  getRestrictedAgentAsset,
  getRestrictedAgentExecution,
  subscribeRestrictedAgentExecution,
  getRestrictedAgentPlanOperation,
  type RestrictedAgentPlanRequest,
} from './lib/restrictedAgentApi'
import {
  clearComposerDraft,
  getComposerDraftSnapshot,
  updateTaskInStore,
  useStore,
  type ComposerDraftSnapshot,
} from './store'
import { isRestrictedAgentEnabled } from './lib/serverApiConfig'
import type {
  RestrictedAgentExecution,
  RestrictedAgentAssetBinding,
  RestrictedAgentPlan,
  TaskRecord,
} from './types'

export type AgentFlowPhase =
  | 'idle'
  | 'planning'
  | 'awaiting_confirmation'
  | 'confirming'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'stale'

export interface PersistedAgentFlow {
  phase: AgentFlowPhase
  plan: RestrictedAgentPlan | null
  execution: RestrictedAgentExecution | null
  taskId: string | null
  error: string | null
  composerSnapshotVersion: number | null
  assetBindings: RestrictedAgentAssetBinding[]
}

interface RestrictedAgentState extends PersistedAgentFlow {
  createPlanFromCurrentInput: (draftSnapshot?: ComposerDraftSnapshot) => Promise<RestrictedAgentPlan | null>
  confirmAndExecute: () => Promise<string | null>
  returnToEditing: () => void
  cancelExecution: () => Promise<void>
  recover: (tasks?: TaskRecord[]) => Promise<void>
  reset: () => void
}

const STORAGE_KEY = 'restricted-agent-flow-v1'
const POLL_INTERVAL_MS = 2_000
const executionPollTimers = new Map<string, ReturnType<typeof setTimeout>>()
const executionEventStops = new Map<string, () => void>()
const finalizingExecutions = new Set<string>()
const taskCreationPromises = new Map<string, Promise<string>>()

function fallbackPersistedState(): PersistedAgentFlow {
  return {
    phase: 'idle',
    plan: null,
    execution: null,
    taskId: null,
    error: null,
    composerSnapshotVersion: null,
    assetBindings: [],
  }
}

export function decodePersistedAgentFlow(value: unknown, now = Date.now()): PersistedAgentFlow {
  const fallback = fallbackPersistedState()
  try {
    const parsed = value as Partial<PersistedAgentFlow> | null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback
    const plan = parsed.plan ? decodeRestrictedAgentPlan(parsed.plan) : null
    const expired = Boolean(plan?.expiresAt && Date.parse(plan.expiresAt) <= now)
    const persistedPhase = parsed.phase ?? 'idle'
    const needsConfirmationBindings = plan?.schemaVersion === 2
      && ['awaiting_confirmation', 'confirming', 'stale'].includes(persistedPhase)
    let assetBindings: RestrictedAgentAssetBinding[] = []
    let bindingError: string | null = null
    if (needsConfirmationBindings) {
      try {
        assetBindings = decodeRestrictedAgentAssetBindings(plan, parsed.assetBindings)
      } catch (error) {
        bindingError = error instanceof Error ? error.message : String(error)
      }
    } else if (Array.isArray(parsed.assetBindings)) {
      assetBindings = parsed.assetBindings
    }
    return {
      phase: expired && persistedPhase === 'awaiting_confirmation'
        ? 'expired'
        : bindingError ? 'stale' : persistedPhase,
      plan,
      execution: parsed.execution ?? null,
      taskId: parsed.taskId ?? null,
      error: bindingError ? `计划输入 binding 已失效：${bindingError}` : parsed.error ?? null,
      composerSnapshotVersion: typeof parsed.composerSnapshotVersion === 'number' ? parsed.composerSnapshotVersion : null,
      assetBindings,
    }
  } catch {
    return fallback
  }
}

export function readPersistedState(): PersistedAgentFlow {
  if (typeof window === 'undefined') return fallbackPersistedState()
  try {
    return decodePersistedAgentFlow(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null'))
  } catch {
    return fallbackPersistedState()
  }
}

function persistState(state: RestrictedAgentState) {
  if (typeof window === 'undefined') return
  const persisted: PersistedAgentFlow = {
    phase: state.phase,
    plan: state.plan,
    execution: state.execution,
    taskId: state.taskId,
    error: state.error,
    composerSnapshotVersion: state.composerSnapshotVersion,
    assetBindings: state.assetBindings,
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted))
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片资源读取失败'))
    reader.onerror = () => reject(reader.error ?? new Error('图片资源读取失败'))
    reader.readAsDataURL(blob)
  })
}

function isTerminalExecution(execution: RestrictedAgentExecution) {
  return ['completed', 'failed', 'cancelled', 'failed_unknown'].includes(execution.status)
}

function stopExecutionWatch(executionId: string) {
  const timer = executionPollTimers.get(executionId)
  if (timer) clearTimeout(timer)
  executionPollTimers.delete(executionId)
  executionEventStops.get(executionId)?.()
  executionEventStops.delete(executionId)
}

function getSourceTaskId(browserImageId: string) {
  return useStore.getState().tasks.find((task) => task.outputImages.includes(browserImageId))?.id ?? null
}

function createPlanRequestFromDraft(draftSnapshot: ComposerDraftSnapshot): RestrictedAgentPlanRequest {
  const request = draftSnapshot.prompt.trim()
  const maskTargetId = draftSnapshot.maskDraft?.targetImageId ?? null
  const inputs = draftSnapshot.inputImages.map((image) => ({
    role: image.id === maskTargetId ? 'mask_target' as const : 'reference' as const,
    browserImageId: image.id,
    sourceTaskId: getSourceTaskId(image.id),
    dataUrl: image.dataUrl,
  }))
  if (maskTargetId && !inputs.some((input) => input.browserImageId === maskTargetId)) {
    throw new Error('遮罩主图已不存在，请重新选择')
  }
  return {
    request,
    size: draftSnapshot.params.size,
    quality: draftSnapshot.params.quality,
    outputFormat: draftSnapshot.params.output_format,
    outputCompression: draftSnapshot.params.output_compression,
    moderation: draftSnapshot.params.moderation,
    imageCount: Math.min(4, Math.max(1, Math.round(draftSnapshot.params.n))),
    inputs,
    mask: draftSnapshot.maskDraft
      ? {
          targetBrowserImageId: draftSnapshot.maskDraft.targetImageId,
          dataUrl: draftSnapshot.maskDraft.maskDataUrl,
        }
      : undefined,
    temporaryProfile: {
      id: draftSnapshot.reusedTaskApiProfileId,
      name: draftSnapshot.reusedTaskApiProfileName,
      missing: draftSnapshot.reusedTaskApiProfileMissing,
    },
  }
}

async function materializePlanInputs(plan: RestrictedAgentPlan) {
  const inputImageIds: string[] = []
  let maskTargetImageId: string | null = null
  let maskImageId: string | null = null

  for (const input of plan.inputs) {
    const dataUrl = await blobToDataUrl(await getRestrictedAgentAsset(input.assetId))
    const imageId = await storeImage(dataUrl, input.role === 'mask' ? 'mask' : 'upload')
    if (input.role === 'mask') maskImageId = imageId
    else {
      inputImageIds.push(imageId)
      if (input.role === 'mask_target') maskTargetImageId = imageId
    }
  }

  if (maskTargetImageId) {
    inputImageIds.sort((id) => id === maskTargetImageId ? -1 : 1)
  }
  return { inputImageIds, maskTargetImageId, maskImageId }
}

async function createTaskForExecution(plan: RestrictedAgentPlan, execution: RestrictedAgentExecution) {
  const pending = taskCreationPromises.get(execution.id)
  if (pending) return pending
  const creation = createTaskForExecutionInternal(plan, execution)
  taskCreationPromises.set(execution.id, creation)
  try {
    return await creation
  } finally {
    taskCreationPromises.delete(execution.id)
  }
}

async function createTaskForExecutionInternal(plan: RestrictedAgentPlan, execution: RestrictedAgentExecution) {
  const taskId = `agent-${execution.id}`
  const existing = useStore.getState().tasks.find((task) => task.agentExecutionId === execution.id || task.id === taskId)
  if (existing) return existing.id
  const operation = getRestrictedAgentPlanOperation(plan)
  if (operation.type === 'openshop.edit') {
    throw new Error('OpenShop operation 尚未接入 Gateway Execution；本阶段不会创建执行任务')
  }
  const generation = operation.generation

  let inputs: Awaited<ReturnType<typeof materializePlanInputs>> = {
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
  }
  try {
    inputs = await materializePlanInputs(plan)
  } catch {
    // 计划快照仍保留输入资源标识；输入缩略图失败不应触发第二次执行。
  }

  const task: TaskRecord = {
    id: taskId,
    prompt: generation.exactPrompt,
    params: {
      size: generation.size,
      quality: generation.quality,
      output_format: generation.outputFormat,
      output_compression: generation.outputCompression,
      moderation: 'auto',
      n: generation.imageCount,
    },
    apiProvider: 'restricted-agent',
    apiProfileName: '受限 Agent Gateway',
    inputImageIds: inputs.inputImageIds,
    maskTargetImageId: inputs.maskTargetImageId,
    maskImageId: inputs.maskImageId,
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: Date.parse(execution.createdAt) || Date.now(),
    finishedAt: null,
    elapsed: null,
    origin: 'restricted-agent',
    agentPlanId: plan.id,
    agentExecutionId: execution.id,
    agentOriginalRequest: plan.originalRequest,
    agentPlanSnapshot: plan,
  }
  const tasks = useStore.getState().tasks
  useStore.getState().setTasks([task, ...tasks])
  await putTask(task)

  const settings = useStore.getState().settings
  const composerSnapshotVersion = useRestrictedAgentStore.getState().composerSnapshotVersion
  if (composerSnapshotVersion !== null) {
    clearComposerDraft('tool', composerSnapshotVersion, settings.clearInputAfterSubmit)
  }
  return taskId
}

async function finalizeExecution(execution: RestrictedAgentExecution, taskId: string | null) {
  if (finalizingExecutions.has(execution.id)) return
  finalizingExecutions.add(execution.id)
  try {
    const task = useStore.getState().tasks.find((item) => item.agentExecutionId === execution.id || item.id === taskId)
    if (!task || task.status !== 'running') return

    if (execution.status === 'completed') {
      try {
        const outputImages: string[] = []
        for (const asset of execution.outputAssets) {
          const dataUrl = await blobToDataUrl(await getRestrictedAgentAsset(asset.id))
          outputImages.push(await storeImage(dataUrl, 'generated'))
        }
        const finishedAt = execution.completedAt ? Date.parse(execution.completedAt) : Date.now()
        updateTaskInStore(task.id, {
          status: outputImages.length ? 'done' : 'error',
          outputImages,
          actualParams: { n: outputImages.length },
          error: outputImages.length ? null : 'Gateway 已完成执行，但没有返回图片资源',
          finishedAt,
          elapsed: Math.max(0, finishedAt - task.createdAt),
        })
      } catch (error) {
        const finishedAt = Date.now()
        updateTaskInStore(task.id, {
          status: 'error',
          error: `执行已完成，但保存结果失败：${error instanceof Error ? error.message : String(error)}`,
          finishedAt,
          elapsed: Math.max(0, finishedAt - task.createdAt),
        })
      }
      return
    }

    const finishedAt = execution.completedAt ? Date.parse(execution.completedAt) : Date.now()
    const fallback = execution.status === 'cancelled'
      ? '执行已取消'
      : execution.status === 'failed_unknown'
        ? '执行状态不确定，系统不会自动重试以避免重复扣费'
        : 'Agent 执行失败'
    updateTaskInStore(task.id, {
      status: 'error',
      error: execution.error?.message || fallback,
      finishedAt,
      elapsed: Math.max(0, finishedAt - task.createdAt),
    })
  } finally {
    finalizingExecutions.delete(execution.id)
  }
}

async function applyExecution(execution: RestrictedAgentExecution, taskId: string | null) {
  const isActive = useRestrictedAgentStore.getState().execution?.id === execution.id
  if (isActive) {
    useRestrictedAgentStore.setState({
      execution,
      phase: execution.status === 'completed'
        ? 'completed'
        : isTerminalExecution(execution)
          ? 'failed'
          : 'executing',
      error: execution.error?.message ?? null,
    })
  }
  if (isTerminalExecution(execution)) {
    stopExecutionWatch(execution.id)
    await finalizeExecution(execution, taskId)
  }
}

async function refreshExecution(executionId: string, taskId: string | null) {
  try {
    const execution = await getRestrictedAgentExecution(executionId)
    await applyExecution(execution, taskId)
    return execution
  } catch (error) {
    const active = useRestrictedAgentStore.getState().execution?.id === executionId
    if (active) useRestrictedAgentStore.setState({ error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

function watchExecution(executionId: string, taskId: string | null) {
  stopExecutionWatch(executionId)
  const schedulePoll = () => {
    if (executionPollTimers.has(executionId)) return
    const timer = setTimeout(async () => {
      executionPollTimers.delete(executionId)
      const execution = await refreshExecution(executionId, taskId)
      if (!execution || !isTerminalExecution(execution)) schedulePoll()
    }, POLL_INTERVAL_MS)
    executionPollTimers.set(executionId, timer)
  }

  if (typeof EventSource !== 'undefined') {
    const stop = subscribeRestrictedAgentExecution(
      executionId,
      () => { void refreshExecution(executionId, taskId) },
      () => { schedulePoll() },
    )
    executionEventStops.set(executionId, stop)
  } else {
    schedulePoll()
  }
  void refreshExecution(executionId, taskId)
}

export const useRestrictedAgentStore = create<RestrictedAgentState>((set, get) => ({
  ...readPersistedState(),

  async createPlanFromCurrentInput(draftSnapshot = getComposerDraftSnapshot('tool')) {
    if (['planning', 'confirming', 'executing'].includes(get().phase)) return null
    const app = useStore.getState()
    if (!isRestrictedAgentEnabled()) {
      app.showToast('当前部署未启用受限 Agent', 'error')
      return null
    }
    const request = draftSnapshot.prompt.trim()
    if (!request) {
      app.showToast('请输入图片需求', 'error')
      return null
    }
    set({
      phase: 'planning',
      plan: null,
      execution: null,
      taskId: null,
      error: null,
      composerSnapshotVersion: draftSnapshot.composerVersion,
      assetBindings: [],
    })
    try {
      const creation = await createRestrictedAgentPlan(createPlanRequestFromDraft(draftSnapshot))
      const currentDraft = getComposerDraftSnapshot('tool')
      const currentHash = await computeRestrictedAgentConfirmationHash(
        creation.plan,
        creation.assetBindings,
        createPlanRequestFromDraft(currentDraft),
      )
      const fresh = creation.plan.schemaVersion !== 2 || currentHash === creation.plan.composerSnapshotHash
      set({
        phase: fresh ? 'awaiting_confirmation' : 'stale',
        plan: creation.plan,
        assetBindings: creation.assetBindings,
        execution: null,
        taskId: null,
        error: fresh ? null : '输入已在规划期间变化，旧计划不可确认',
      })
      const plan = creation.plan
      return plan
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ phase: 'failed', error: message })
      app.showToast(message, 'error')
      return null
    }
  },

  async confirmAndExecute() {
    const current = get()
    if (current.phase === 'confirming' || current.phase === 'executing') return current.taskId
    if (current.phase !== 'awaiting_confirmation') return null
    const { plan, assetBindings } = current
    if (!plan) return null
    if (Date.parse(plan.expiresAt) <= Date.now()) {
      set({ phase: 'expired', error: '计划已过期，请重新生成计划' })
      return null
    }
    const operation = getRestrictedAgentPlanOperation(plan)
    if (operation.type === 'openshop.edit') {
      set({ error: 'OpenShop 计划将在下一阶段接入浏览器执行，本阶段不可确认' })
      return null
    }
    set({ phase: 'confirming', error: null })
    try {
      let composerSnapshotHash: string | null = null
      if (plan.schemaVersion === 2) {
        const currentDraft = getComposerDraftSnapshot('tool')
        composerSnapshotHash = await computeRestrictedAgentConfirmationHash(
          plan,
          assetBindings,
          createPlanRequestFromDraft(currentDraft),
        )
        if (composerSnapshotHash !== plan.composerSnapshotHash) {
          set({ phase: 'stale', error: 'Prompt、输入图片、Mask、参数或临时 Profile 已变化，旧计划不可确认' })
          return null
        }
      }
      const execution = await executeRestrictedAgentPlan(plan, composerSnapshotHash)
      set({
        phase: isTerminalExecution(execution) ? (execution.status === 'completed' ? 'completed' : 'failed') : 'executing',
        execution,
        error: execution.error?.message ?? null,
      })
      if (!isTerminalExecution(execution)) watchExecution(execution.id, null)
      const taskId = await createTaskForExecution(plan, execution)
      set({ taskId, composerSnapshotVersion: null, assetBindings: [] })
      const latestExecution = get().execution?.id === execution.id ? get().execution! : execution
      await applyExecution(latestExecution, taskId)
      if (!isTerminalExecution(latestExecution)) watchExecution(latestExecution.id, taskId)
      return taskId
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const expired = /过期|expired/i.test(message)
      const acceptedExecution = get().execution
      set({
        phase: acceptedExecution && !isTerminalExecution(acceptedExecution)
          ? 'executing'
          : expired ? 'expired' : 'failed',
        error: message,
      })
      useStore.getState().showToast(message, 'error')
      return null
    }
  },

  returnToEditing() {
    set({ phase: 'idle', plan: null, execution: null, taskId: null, error: null, composerSnapshotVersion: null, assetBindings: [] })
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-input-bar] [contenteditable="true"]')?.focus())
  },

  async cancelExecution() {
    const execution = get().execution
    if (!execution || isTerminalExecution(execution)) return
    try {
      await applyExecution(await cancelRestrictedAgentExecution(execution.id), get().taskId)
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  async recover(tasks = useStore.getState().tasks) {
    const active = get().execution
    if (!active && get().phase === 'confirming' && get().plan) {
      set({ phase: 'awaiting_confirmation', error: '上次确认未取得执行编号，请再次确认；服务端会按计划幂等返回同一执行。' })
    }
    let activeTaskId = get().taskId
    if (active && get().plan && !tasks.some((task) => task.agentExecutionId === active.id)) {
      try {
        activeTaskId = await createTaskForExecution(get().plan!, active)
        set({ taskId: activeTaskId })
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
      }
    }
    const recoverable = tasks.filter((task) => task.origin === 'restricted-agent' && task.status === 'running' && task.agentExecutionId)
    for (const task of recoverable) watchExecution(task.agentExecutionId!, task.id)
    if (active && !isTerminalExecution(active)) watchExecution(active.id, activeTaskId)
    if (active && isTerminalExecution(active)) await finalizeExecution(active, activeTaskId)
  },

  reset() {
    const executionId = get().execution?.id
    if (executionId) stopExecutionWatch(executionId)
    set({ phase: 'idle', plan: null, execution: null, taskId: null, error: null, composerSnapshotVersion: null, assetBindings: [] })
  },
}))

useRestrictedAgentStore.subscribe(persistState)

let freshnessRevision = 0
let lastToolComposerVersion = getComposerDraftSnapshot('tool').composerVersion

async function refreshPlanFreshness() {
  const revision = ++freshnessRevision
  const flow = useRestrictedAgentStore.getState()
  if ((flow.phase !== 'awaiting_confirmation' && flow.phase !== 'stale')
    || !flow.plan
    || flow.plan.schemaVersion !== 2) return
  if (Date.parse(flow.plan.expiresAt) <= Date.now()) {
    useRestrictedAgentStore.setState({ phase: 'expired', error: '计划已过期，请重新生成计划' })
    return
  }
  try {
    const draft = getComposerDraftSnapshot('tool')
    const currentHash = await computeRestrictedAgentConfirmationHash(
      flow.plan,
      flow.assetBindings,
      createPlanRequestFromDraft(draft),
    )
    const latest = useRestrictedAgentStore.getState()
    if (revision !== freshnessRevision || latest.plan?.id !== flow.plan.id
      || (latest.phase !== 'awaiting_confirmation' && latest.phase !== 'stale')) return
    const fresh = currentHash === flow.plan.composerSnapshotHash
    useRestrictedAgentStore.setState({
      phase: fresh ? 'awaiting_confirmation' : 'stale',
      error: fresh ? null : 'Prompt、输入图片、Mask、参数或临时 Profile 已变化，旧计划不可确认',
    })
  } catch (error) {
    if (revision !== freshnessRevision) return
    useRestrictedAgentStore.setState({
      phase: 'stale',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

useStore.subscribe(() => {
  const currentVersion = getComposerDraftSnapshot('tool').composerVersion
  if (currentVersion === lastToolComposerVersion) return
  lastToolComposerVersion = currentVersion
  void refreshPlanFreshness()
})

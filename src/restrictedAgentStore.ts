import { create } from 'zustand'
import {
  claimOpenShopToolLocalRun,
  cleanupExpiredOpenShopToolOutputDrafts,
  createOpenShopToolLocalRunRecord,
  getOpenShopToolLocalRun,
  getOpenShopToolOutputDraft,
  getVerifiedCompletedOpenShopToolTask,
  putTask,
  storeImage,
  storeOpenShopToolExport,
  transitionOpenShopToolLocalRun,
} from './lib/db'
import {
  cancelRestrictedAgentExecution,
  computeRestrictedAgentConfirmationHash,
  decodeRestrictedAgentAssetBindings,
  decodeRestrictedAgentPlan,
  executeRestrictedAgentPlan,
  getRestrictedAgentAsset,
  getRestrictedAgentExecution,
  getRestrictedAgentPlan,
  subscribeRestrictedAgentExecution,
  getRestrictedAgentPlanOperation,
  streamRestrictedAgentPlan,
  type RestrictedAgentPlanRequest,
} from './lib/restrictedAgentApi'
import { openShopToolRunner, OpenShopToolRunnerError } from './lib/openShopToolRunner'
import {
  clearComposerDraft,
  getComposerDraftSnapshot,
  saveOpenShopEdit,
  updateTaskInStore,
  useStore,
  type ComposerDraftSnapshot,
} from './store'
import { isRestrictedAgentEnabled } from './lib/serverApiConfig'
import type {
  RestrictedAgentExecution,
  RestrictedAgentAssetBinding,
  RestrictedAgentPlan,
  OpenShopToolLocalRun,
  ToolAgentPlan,
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
  localRunId: string | null
}

interface RestrictedAgentState extends PersistedAgentFlow {
  localRun: OpenShopToolLocalRun | null
  planningText: string
  createPlanFromCurrentInput: (draftSnapshot?: ComposerDraftSnapshot, webSearchEnabled?: boolean) => Promise<RestrictedAgentPlan | null>
  retryOpenShopSave: (options?: OpenShopSaveAttemptOptions) => Promise<string | null>
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
const openShopRunPromises = new Map<string, Promise<string | null>>()
const openShopSavePromises = new Map<string, Promise<string | null>>()
const openShopSaveControllers = new Map<string, AbortController>()
const OPENSHOP_OUTPUT_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const OPENSHOP_SAVE_TIMEOUT_MS = 30_000

export interface OpenShopSaveAttemptOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

class OpenShopConfirmationError extends Error {
  constructor(readonly phase: 'stale' | 'expired' | 'failed', message: string) {
    super(message)
    this.name = 'OpenShopConfirmationError'
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function createOpenShopRunId(plan: ToolAgentPlan) {
  return `openshop:${plan.id}:${plan.version}:${plan.composerSnapshotHash}`
}

function createOpenShopTaskId(plan: ToolAgentPlan) {
  return `agent-openshop-${plan.id}-${plan.version}-${plan.composerSnapshotHash}`
}

function getLocalRunError(error: unknown) {
  if (error instanceof OpenShopToolRunnerError) {
    return { code: error.code, message: error.message, retryable: error.retryable }
  }
  return {
    code: 'LOCAL_RUN_FAILED',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  }
}

function fallbackPersistedState(): PersistedAgentFlow {
  return {
    phase: 'idle',
    plan: null,
    execution: null,
    taskId: null,
    error: null,
    composerSnapshotVersion: null,
    assetBindings: [],
    localRunId: null,
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
    const interruptedAutomaticExecution = persistedPhase === 'awaiting_confirmation' || persistedPhase === 'confirming'
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
      phase: expired && interruptedAutomaticExecution
        ? 'expired'
        : bindingError || interruptedAutomaticExecution ? 'stale' : persistedPhase,
      plan,
      execution: parsed.execution ?? null,
      taskId: parsed.taskId ?? null,
      error: bindingError
        ? `计划输入 binding 已失效：${bindingError}`
        : interruptedAutomaticExecution ? '自动执行在页面刷新前中断，请重新规划'
          : parsed.error ?? null,
      composerSnapshotVersion: typeof parsed.composerSnapshotVersion === 'number' ? parsed.composerSnapshotVersion : null,
      assetBindings,
      localRunId: typeof parsed.localRunId === 'string' && parsed.localRunId ? parsed.localRunId : null,
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
    localRunId: state.localRunId,
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

function createPlanRequestFromDraft(draftSnapshot: ComposerDraftSnapshot, webSearchEnabled = false): RestrictedAgentPlanRequest {
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
    webSearchEnabled,
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

async function validateOpenShopConfirmation(
  plan: RestrictedAgentPlan,
  assetBindings: RestrictedAgentAssetBinding[],
) {
  if (plan.schemaVersion !== 2) {
    throw new OpenShopConfirmationError('failed', 'OpenShop 只能执行 Tool Plan schema v2')
  }
  const operation = getRestrictedAgentPlanOperation(plan)
  if (operation.type !== 'openshop.edit') {
    throw new OpenShopConfirmationError('failed', '当前计划不是 OpenShop operation')
  }
  if (plan.status !== 'awaiting_confirmation') {
    throw new OpenShopConfirmationError(
      plan.status === 'expired' ? 'expired' : 'stale',
      `计划状态已变化：${plan.status}`,
    )
  }
  if (Date.parse(plan.expiresAt) <= Date.now()) {
    throw new OpenShopConfirmationError('expired', '计划已过期，请重新生成计划')
  }

  let decodedBindings: RestrictedAgentAssetBinding[]
  try {
    decodedBindings = decodeRestrictedAgentAssetBindings(plan, assetBindings)
  } catch (error) {
    throw new OpenShopConfirmationError(
      'stale',
      `计划输入 binding 已失效：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const binding = decodedBindings.find((item) => item.gatewayAssetId === operation.inputAssetId)
  if (!binding || binding.role !== 'reference' || !binding.browserImageId) {
    throw new OpenShopConfirmationError('stale', 'OpenShop inputAssetId 缺少有效浏览器图片 binding')
  }
  if (binding.sourceTaskId) {
    const sourceTask = useStore.getState().tasks.find((task) => task.id === binding.sourceTaskId)
    if (!sourceTask || !sourceTask.outputImages.includes(binding.browserImageId)) {
      throw new OpenShopConfirmationError('stale', 'OpenShop sourceTaskId 与浏览器图片来源不匹配')
    }
  }

  const draft = getComposerDraftSnapshot('tool')
  const currentHash = await computeRestrictedAgentConfirmationHash(
    plan,
    decodedBindings,
    createPlanRequestFromDraft(draft),
  )
  if (currentHash !== plan.composerSnapshotHash) {
    throw new OpenShopConfirmationError('stale', 'Prompt、输入图片、Mask、参数或临时 Profile 已变化，旧计划不可确认')
  }

  const freshPlan = await getRestrictedAgentPlan(plan.id)
  if (freshPlan.schemaVersion !== 2
    || freshPlan.version !== plan.version
    || freshPlan.composerSnapshotHash !== plan.composerSnapshotHash
    || stableJson(freshPlan) !== stableJson(plan)) {
    throw new OpenShopConfirmationError('stale', 'Gateway 计划版本或冻结快照已变化，请重新规划')
  }
  if (freshPlan.status !== 'awaiting_confirmation') {
    throw new OpenShopConfirmationError(
      freshPlan.status === 'expired' ? 'expired' : 'stale',
      `Gateway 计划状态已变化：${freshPlan.status}`,
    )
  }
  if (Date.parse(freshPlan.expiresAt) <= Date.now()) {
    throw new OpenShopConfirmationError('expired', '计划已过期，请重新生成计划')
  }

  return { plan: freshPlan, operation, binding, draft }
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

async function createTaskForOpenShopRun(run: OpenShopToolLocalRun) {
  const existing = useStore.getState().tasks.find((task) => (
    task.id === run.taskId || task.agentRunId === run.id || task.agentLocalRunId === run.id
  ))
  if (existing) return existing.id
  const task: TaskRecord = {
    id: run.taskId,
    prompt: run.planSnapshot.originalRequest,
    params: { ...run.taskParams },
    apiProvider: 'openshop',
    apiProfileName: 'OpenShop Tool Agent',
    apiModel: 'OpenShop',
    inputImageIds: [run.inputImageId],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: run.createdAt,
    finishedAt: null,
    elapsed: null,
    origin: 'restricted-agent',
    sourceTaskId: run.sourceTaskId ?? undefined,
    agentPlanId: run.planId,
    agentOriginalRequest: run.planSnapshot.originalRequest,
    agentPlanSnapshot: run.planSnapshot,
    agentRunId: run.id,
    agentLocalRunId: run.id,
    agentLocalRunStatus: run.status,
    agentLocalSaveStatus: run.saveStatus,
  }
  await putTask(task)
  useStore.getState().setTasks([task, ...useStore.getState().tasks.filter((item) => item.id !== task.id)])
  clearComposerDraft('tool', run.composerSnapshotVersion, useStore.getState().settings.clearInputAfterSubmit)
  return task.id
}

function reflectOpenShopRunInTask(run: OpenShopToolLocalRun, terminalMessage?: string) {
  const task = useStore.getState().tasks.find((item) => item.id === run.taskId || item.agentRunId === run.id)
  if (!task) return
  const terminal = ['completed', 'cancelled', 'failed', 'interrupted', 'expired'].includes(run.status)
  updateTaskInStore(task.id, {
    status: run.status === 'completed' ? 'done' : terminal || run.status === 'exported' ? 'error' : 'running',
    error: run.status === 'completed' ? null : terminalMessage ?? run.error?.message ?? null,
    finishedAt: terminal || run.status === 'exported' ? run.completedAt ?? Date.now() : null,
    elapsed: terminal || run.status === 'exported'
      ? Math.max(0, (run.completedAt ?? Date.now()) - task.createdAt)
      : null,
    agentLocalRunStatus: run.status,
    agentLocalSaveStatus: run.saveStatus,
  })
}

function syncOpenShopRunState(run: OpenShopToolLocalRun) {
  reflectOpenShopRunInTask(run)
  const phase: AgentFlowPhase = run.status === 'completed'
    ? 'completed'
    : run.status === 'running' || run.status === 'saving'
      ? 'executing'
      : run.status === 'expired'
        ? 'expired'
        : 'failed'
  useRestrictedAgentStore.setState({
    localRun: run,
    localRunId: run.id,
    taskId: run.taskId,
    phase,
    error: run.error?.message ?? (run.status === 'exported' ? 'OpenShop 已导出结果等待重试保存' : null),
  })
}

function readAbortReason(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException('OpenShop 本地保存已取消', 'AbortError')
}

function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(readAbortReason(signal))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = () => {
      if (settled) return false
      settled = true
      signal.removeEventListener('abort', onAbort)
      return true
    }
    const onAbort = () => { if (finish()) reject(readAbortReason(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { if (finish()) resolve(value) },
      (error) => { if (finish()) reject(error) },
    )
  })
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

async function saveExportedOpenShopRun(
  runId: string,
  options: OpenShopSaveAttemptOptions = {},
): Promise<string | null> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? OPENSHOP_SAVE_TIMEOUT_MS)
  const controller = new AbortController()
  const onExternalAbort = () => controller.abort(
    options.signal?.reason instanceof Error
      ? options.signal.reason
      : new DOMException('OpenShop 本地保存已取消', 'AbortError'),
  )
  options.signal?.addEventListener('abort', onExternalAbort, { once: true })
  if (options.signal?.aborted) onExternalAbort()
  const timeout = globalThis.setTimeout(
    () => controller.abort(new DOMException('OpenShop 本地保存超时', 'TimeoutError')),
    timeoutMs,
  )
  openShopSaveControllers.set(runId, controller)
  let saving: OpenShopToolLocalRun | null = null

  try {
    saving = await transitionOpenShopToolLocalRun(runId, ['exported'], {
      status: 'saving',
      saveStatus: 'saving',
      error: null,
      errorStage: null,
      completedAt: null,
    }, controller.signal)
    if (!saving) {
      const current = await getOpenShopToolLocalRun(runId, controller.signal)
      if (!current) return null
      syncOpenShopRunState(current)
      return current.status === 'completed' ? current.taskId : null
    }

    useRestrictedAgentStore.setState({
      localRun: saving,
      localRunId: saving.id,
      taskId: saving.taskId,
      phase: 'executing',
      error: null,
    })
    reflectOpenShopRunInTask(saving)

    const draft = await getOpenShopToolOutputDraft(runId, controller.signal)
    if (!draft) throw new Error('OpenShop 已导出结果不存在，不能重试保存')
    if (draft.expiresAt <= Date.now()) {
      await cleanupExpiredOpenShopToolOutputDrafts()
      throw new Error('OpenShop 已导出结果已过期，请重新规划')
    }
    const completedAt = Date.now()
    const completed: OpenShopToolLocalRun = {
      ...saving,
      status: 'completed',
      saveStatus: 'completed',
      blobId: null,
      error: null,
      errorStage: null,
      updatedAt: completedAt,
      completedAt,
    }
    const task = await waitForAbortable(saveOpenShopEdit({
      sourceTaskId: saving.sourceTaskId,
      inputImageIds: [saving.inputImageId],
      outputImage: draft.blob,
      taskId: saving.taskId,
      origin: 'restricted-agent',
      prompt: saving.planSnapshot.originalRequest,
      createdAt: saving.createdAt,
      fallbackParams: saving.taskParams,
      agentPlanId: saving.planId,
      agentOriginalRequest: saving.planSnapshot.originalRequest,
      agentPlanSnapshot: saving.planSnapshot,
      agentRunId: saving.id,
      agentLocalRunId: saving.id,
      agentLocalRunStatus: 'completed',
      agentLocalSaveStatus: 'completed',
      signal: controller.signal,
      timeoutMs,
      completeToolRun: { run: completed, draft, expectedStatus: 'saving' },
    }), controller.signal)
    useRestrictedAgentStore.setState({
      localRun: completed,
      localRunId: completed.id,
      taskId: task.id,
      phase: 'completed',
      error: null,
      composerSnapshotVersion: null,
    })
    return task.id
  } catch (error) {
    if (!saving) {
      const current = useRestrictedAgentStore.getState().localRun
      if (current?.id === runId) syncOpenShopRunState(current)
      return null
    }
    let durable: OpenShopToolLocalRun | undefined
    try {
      durable = await getOpenShopToolLocalRun(runId)
    } catch (readError) {
      const message = readError instanceof Error ? readError.message : String(readError)
      useRestrictedAgentStore.setState({ phase: 'failed', error: message })
      return null
    }
    if (durable?.status === 'completed') {
      syncOpenShopRunState(durable)
      return durable.taskId
    }
    const message = error instanceof Error ? error.message : String(error)
    const errorCode = error instanceof DOMException && error.name === 'TimeoutError'
      ? 'SAVE_TIMEOUT'
      : error instanceof DOMException && error.name === 'AbortError'
        ? 'SAVE_CANCELLED'
        : 'SAVE_FAILED'
    let exported: OpenShopToolLocalRun | null = null
    try {
      exported = await transitionOpenShopToolLocalRun(runId, ['saving'], {
        status: 'exported',
        saveStatus: 'failed',
        error: { code: errorCode, message: `OpenShop 已导出，但本地保存失败：${message}`, retryable: true },
        errorStage: 'save',
        completedAt: null,
      })
    } catch {
      // 继续读取 durable 状态；invalid/并发状态必须以持久层为准。
    }
    if (exported) {
      syncOpenShopRunState(exported)
      return null
    }
    try {
      durable = await getOpenShopToolLocalRun(runId)
      if (durable) {
        syncOpenShopRunState(durable)
        return durable.status === 'completed' ? durable.taskId : null
      }
    } catch (readError) {
      useRestrictedAgentStore.setState({
        phase: 'failed',
        error: readError instanceof Error ? readError.message : String(readError),
      })
    }
    return null
  } finally {
    globalThis.clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onExternalAbort)
    if (openShopSaveControllers.get(runId) === controller) openShopSaveControllers.delete(runId)
  }
}

function getOrCreateOpenShopSaveAttempt(
  runId: string,
  options: OpenShopSaveAttemptOptions = {},
): Promise<string | null> {
  const existing = openShopSavePromises.get(runId)
  if (existing) return existing
  const local = useRestrictedAgentStore.getState().localRun
  const attempt = local?.id === runId && local.status === 'exported'
    ? saveExportedOpenShopRun(runId, options)
    : (async () => {
        const run = await getOpenShopToolLocalRun(runId)
        if (!run) return null
        if (run.status !== 'exported') {
          syncOpenShopRunState(run)
          return run.status === 'completed' ? run.taskId : null
        }
        return saveExportedOpenShopRun(runId, options)
      })()
  openShopSavePromises.set(runId, attempt)
  const cleanup = () => {
    if (openShopSavePromises.get(runId) === attempt) openShopSavePromises.delete(runId)
  }
  attempt.then(cleanup, cleanup)
  return attempt
}

async function executeOpenShopLocalRun(run: OpenShopToolLocalRun): Promise<string | null> {
  useRestrictedAgentStore.setState({
    localRun: run,
    localRunId: run.id,
    taskId: run.taskId,
    phase: 'executing',
    error: null,
  })
  reflectOpenShopRunInTask(run)
  try {
    const exported = await openShopToolRunner({
      sourceTaskId: run.sourceTaskId,
      inputAssetId: run.inputImageId,
      commands: run.commands,
      outputFormat: run.outputFormat,
      saveOutput: false,
    })
    const exportedRun = await storeOpenShopToolExport(run.id, {
      runId: run.id,
      blob: exported.blob,
      filename: exported.filename,
      document: exported.document,
      createdAt: Date.now(),
      expiresAt: Date.now() + OPENSHOP_OUTPUT_DRAFT_TTL_MS,
    })
    useRestrictedAgentStore.setState({ localRun: exportedRun, phase: 'executing', error: null })
    return getOrCreateOpenShopSaveAttempt(run.id)
  } catch (error) {
    const durable = await getOpenShopToolLocalRun(run.id)
    if (durable?.status === 'exported') return getOrCreateOpenShopSaveAttempt(run.id)
    if (durable?.status === 'completed') return durable.taskId
    const localError = getLocalRunError(error)
    const status = localError.code === 'CANCELLED' ? 'cancelled' as const : 'failed' as const
    const failed = await transitionOpenShopToolLocalRun(run.id, ['running'], {
      status,
      saveStatus: 'not_started',
      error: localError,
      errorStage: 'execution',
      completedAt: null,
    })
    if (failed) {
      reflectOpenShopRunInTask(failed)
      useRestrictedAgentStore.setState({
        localRun: failed,
        localRunId: failed.id,
        taskId: failed.taskId,
        phase: 'failed',
        error: failed.error?.message ?? null,
      })
    }
    return null
  }
}

async function confirmOpenShopPlan(
  plan: RestrictedAgentPlan,
  assetBindings: RestrictedAgentAssetBinding[],
): Promise<string | null> {
  useRestrictedAgentStore.setState({ phase: 'confirming', error: null })
  try {
    const validated = await validateOpenShopConfirmation(plan, assetBindings)
    const now = Date.now()
    const runId = createOpenShopRunId(validated.plan)
    const candidate = await createOpenShopToolLocalRunRecord({
      id: runId,
      idempotencyKey: runId,
      taskId: createOpenShopTaskId(validated.plan),
      planId: validated.plan.id,
      planVersion: validated.plan.version,
      composerSnapshotHash: validated.plan.composerSnapshotHash,
      composerSnapshotVersion: validated.draft.composerVersion,
      planSnapshot: validated.plan,
      sourceTaskId: validated.binding.sourceTaskId,
      inputImageId: validated.binding.browserImageId as string,
      inputBinding: {
        gatewayAssetId: validated.binding.gatewayAssetId,
        browserImageId: validated.binding.browserImageId as string,
        sourceTaskId: validated.binding.sourceTaskId,
        role: 'reference',
        ordinal: validated.binding.ordinal,
      },
      taskParams: { ...validated.draft.params },
      commands: validated.operation.commands.map((command) => structuredClone(command)),
      outputFormat: 'png',
      blobId: null,
      status: 'running',
      saveStatus: 'not_started',
      error: null,
      errorStage: null,
      createdAt: now,
      startedAt: now,
      exportedAt: null,
      updatedAt: now,
      completedAt: null,
    })
    const claimed = await claimOpenShopToolLocalRun(candidate)
    if (claimed.run.status === 'completed') {
      const completedTask = await getVerifiedCompletedOpenShopToolTask(claimed.run)
      if (!useStore.getState().tasks.some((task) => task.id === completedTask.id)) {
        useStore.getState().setTasks([
          completedTask,
          ...useStore.getState().tasks.filter((task) => task.id !== completedTask.id),
        ])
      }
      clearComposerDraft('tool', claimed.run.composerSnapshotVersion, useStore.getState().settings.clearInputAfterSubmit)
      useRestrictedAgentStore.setState({
        localRun: claimed.run,
        localRunId: claimed.run.id,
        taskId: completedTask.id,
        composerSnapshotVersion: null,
        phase: 'completed',
        error: null,
      })
      return completedTask.id
    }
    const taskId = await createTaskForOpenShopRun(claimed.run)
    useRestrictedAgentStore.setState({
      localRun: claimed.run,
      localRunId: claimed.run.id,
      taskId,
      composerSnapshotVersion: null,
    })
    if (claimed.created) return executeOpenShopLocalRun(claimed.run)

    if (claimed.run.status === 'running' || claimed.run.status === 'saving') {
      useRestrictedAgentStore.setState({
        phase: 'executing',
        error: '相同计划已由当前浏览器中的本地 Run 处理，不会重复执行',
      })
      return claimed.run.taskId
    }
    useRestrictedAgentStore.setState({
      phase: 'failed',
      error: claimed.run.error?.message ?? (
        claimed.run.status === 'exported'
          ? 'OpenShop 已导出结果等待重试保存'
          : '相同计划已有终态 Run；重新执行前必须重新规划'
      ),
    })
    return claimed.run.taskId
  } catch (error) {
    const phase = error instanceof OpenShopConfirmationError ? error.phase : 'failed'
    const message = error instanceof Error ? error.message : String(error)
    useRestrictedAgentStore.setState({ phase, error: message })
    useStore.getState().showToast(message, 'error')
    return null
  }
}

export const useRestrictedAgentStore = create<RestrictedAgentState>((set, get) => ({
  ...readPersistedState(),
  localRun: null,
  planningText: '',

  async createPlanFromCurrentInput(draftSnapshot = getComposerDraftSnapshot('tool'), webSearchEnabled = false) {
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
      planningText: '',
      composerSnapshotVersion: draftSnapshot.composerVersion,
      assetBindings: [],
      localRunId: null,
      localRun: null,
    })
    try {
      const creation = await streamRestrictedAgentPlan(
        createPlanRequestFromDraft(draftSnapshot, webSearchEnabled),
        { onDelta: (text) => set((state) => ({ planningText: state.planningText + text })) },
      )
      const currentDraft = getComposerDraftSnapshot('tool')
      const currentHash = await computeRestrictedAgentConfirmationHash(
        creation.plan,
        creation.assetBindings,
        createPlanRequestFromDraft(currentDraft),
      )
      const fresh = creation.plan.schemaVersion !== 2 || currentHash === creation.plan.composerSnapshotHash
      set({
        phase: fresh ? 'confirming' : 'stale',
        plan: creation.plan,
        assetBindings: creation.assetBindings,
        execution: null,
        taskId: null,
        error: fresh ? null : '输入已在规划期间变化，旧计划不可确认',
        localRunId: null,
        localRun: null,
      })
      const plan = creation.plan
      if (fresh) await automaticallyExecutePlan(plan, creation.assetBindings)
      return plan
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ phase: 'failed', error: message })
      app.showToast(message, 'error')
      return null
    }
  },

  retryOpenShopSave(options) {
    const runId = get().localRunId
    if (!runId) return Promise.resolve(null)
    return getOrCreateOpenShopSaveAttempt(runId, options)
  },

  returnToEditing() {
    set({
      phase: 'idle', plan: null, execution: null, taskId: null, error: null,
      composerSnapshotVersion: null, assetBindings: [], localRunId: null, localRun: null, planningText: '',
    })
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-input-bar] [contenteditable="true"]')?.focus())
  },

  async cancelExecution() {
    const localRun = get().localRun
    const localRunId = localRun?.id ?? get().localRunId
    const saveController = localRunId ? openShopSaveControllers.get(localRunId) : undefined
    if (saveController) {
      saveController.abort(new DOMException('用户取消了 OpenShop 本地保存', 'AbortError'))
      return
    }
    if (localRun?.status === 'saving') {
      return
    }
    const execution = get().execution
    if (!execution || isTerminalExecution(execution)) return
    try {
      await applyExecution(await cancelRestrictedAgentExecution(execution.id), get().taskId)
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  async recover(tasks = useStore.getState().tasks) {
    try {
      await cleanupExpiredOpenShopToolOutputDrafts()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ phase: 'failed', error: message, localRun: null })
      return
    }
    const persistedRunId = get().localRunId
    if (persistedRunId) {
      let run: OpenShopToolLocalRun | undefined
      try {
        run = await getOpenShopToolLocalRun(persistedRunId)
      } catch (error) {
        set({
          phase: 'failed',
          error: error instanceof Error ? error.message : String(error),
          localRun: null,
        })
        return
      }
      if (run) {
        const taskExists = tasks.some((task) => task.id === run?.taskId || task.agentRunId === run?.id)
        if (!taskExists && run.status !== 'completed') await createTaskForOpenShopRun(run)
        const draft = await getOpenShopToolOutputDraft(run.id)
        if (run.status === 'running') {
          const transitioned = await transitionOpenShopToolLocalRun(run.id, ['running'], {
            status: 'interrupted',
            error: { code: 'INTERRUPTED', message: '页面刷新中断了 OpenShop 执行，系统不会自动重放', retryable: false },
            errorStage: 'recovery',
            completedAt: null,
          })
          run = transitioned ?? await getOpenShopToolLocalRun(run.id) ?? run
        } else if (run.status === 'saving') {
          const transitioned = await transitionOpenShopToolLocalRun(run.id, ['saving'], draft ? {
            status: 'exported',
            saveStatus: 'failed',
            error: { code: 'SAVE_INTERRUPTED', message: '页面刷新中断了保存，可直接重试保存已导出的结果', retryable: true },
            errorStage: 'save',
            completedAt: null,
          } : {
            status: 'expired',
            saveStatus: 'failed',
            blobId: null,
            error: { code: 'OUTPUT_DRAFT_MISSING', message: '页面刷新中断了保存，且没有可恢复的导出结果', retryable: false },
            errorStage: 'expiry',
            completedAt: null,
          })
          run = transitioned ?? await getOpenShopToolLocalRun(run.id) ?? run
        } else if (run.status === 'exported' && !draft) {
          const transitioned = await transitionOpenShopToolLocalRun(run.id, ['exported'], {
            status: 'expired',
            saveStatus: 'failed',
            blobId: null,
            error: { code: 'OUTPUT_DRAFT_MISSING', message: 'OpenShop 已导出结果缺失，不能重试保存', retryable: false },
            errorStage: 'expiry',
            completedAt: null,
          })
          run = transitioned ?? await getOpenShopToolLocalRun(run.id) ?? run
        }
        const phase: AgentFlowPhase = run.status === 'completed'
          ? 'completed'
          : run.status === 'running' || run.status === 'saving'
            ? 'executing'
            : 'failed'
        set({
          localRun: run,
          localRunId: run.id,
          taskId: run.taskId,
          phase,
          error: run.error?.message ?? (run.status === 'exported' ? 'OpenShop 已导出结果等待重试保存' : null),
        })
        reflectOpenShopRunInTask(run)
      }
    } else if (!get().execution && get().phase === 'confirming' && get().plan) {
      set({ phase: 'stale', error: '自动执行未开始本地 Run，请重新规划' })
    }

    const active = get().execution
    if (!persistedRunId && !active && get().phase === 'confirming' && get().plan) {
      set({ phase: 'stale', error: '自动执行未取得执行编号，请重新规划' })
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
    set({
      phase: 'idle', plan: null, execution: null, taskId: null, error: null,
      composerSnapshotVersion: null, assetBindings: [], localRunId: null, localRun: null, planningText: '',
    })
  },
}))

async function automaticallyExecutePlan(
  plan: RestrictedAgentPlan,
  assetBindings: RestrictedAgentAssetBinding[],
): Promise<string | null> {
  const current = useRestrictedAgentStore.getState()
  if (current.phase !== 'confirming' || current.plan?.id !== plan.id || current.plan.version !== plan.version) {
    return current.taskId
  }
  const operation = getRestrictedAgentPlanOperation(plan)
  if (operation.type === 'openshop.edit' && plan.schemaVersion === 2) {
    const runId = createOpenShopRunId(plan)
    const pending = openShopRunPromises.get(runId)
    if (pending) return pending
    const confirmation = confirmOpenShopPlan(plan, assetBindings)
      .finally(() => openShopRunPromises.delete(runId))
    openShopRunPromises.set(runId, confirmation)
    return confirmation
  }
  if (Date.parse(plan.expiresAt) <= Date.now()) {
    useRestrictedAgentStore.setState({ phase: 'expired', error: '计划已过期，请重新生成计划' })
    return null
  }
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
        useRestrictedAgentStore.setState({ phase: 'stale', error: 'Prompt、输入图片、Mask、参数或临时 Profile 已变化，旧计划不可确认' })
        return null
      }
    }
    const execution = await executeRestrictedAgentPlan(plan, composerSnapshotHash)
    useRestrictedAgentStore.setState({
      phase: isTerminalExecution(execution) ? (execution.status === 'completed' ? 'completed' : 'failed') : 'executing',
      execution,
      error: execution.error?.message ?? null,
    })
    if (!isTerminalExecution(execution)) watchExecution(execution.id, null)
    const taskId = await createTaskForExecution(plan, execution)
    useRestrictedAgentStore.setState({ taskId, composerSnapshotVersion: null, assetBindings: [], localRunId: null, localRun: null })
    const latestExecution = useRestrictedAgentStore.getState().execution?.id === execution.id
      ? useRestrictedAgentStore.getState().execution!
      : execution
    await applyExecution(latestExecution, taskId)
    if (!isTerminalExecution(latestExecution)) watchExecution(latestExecution.id, taskId)
    return taskId
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const expired = /过期|expired/i.test(message)
    const acceptedExecution = useRestrictedAgentStore.getState().execution
    useRestrictedAgentStore.setState({
      phase: acceptedExecution && !isTerminalExecution(acceptedExecution)
        ? 'executing'
        : expired ? 'expired' : 'failed',
      error: message,
    })
    useStore.getState().showToast(message, 'error')
    return null
  }
}

useRestrictedAgentStore.subscribe(persistState)

let freshnessRevision = 0
let lastToolComposerVersion = getComposerDraftSnapshot('tool').composerVersion

async function refreshPlanFreshness() {
  const revision = ++freshnessRevision
  const flow = useRestrictedAgentStore.getState()
  if (flow.phase !== 'stale' || !flow.plan
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
    if (revision !== freshnessRevision || latest.plan?.id !== flow.plan.id || latest.phase !== 'stale') return
    const fresh = currentHash === flow.plan.composerSnapshotHash
    useRestrictedAgentStore.setState({
      phase: 'stale',
      error: fresh
        ? '计划曾在自动执行前失效，请重新规划'
        : 'Prompt、输入图片、Mask、参数或临时 Profile 已变化，旧计划不可确认',
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

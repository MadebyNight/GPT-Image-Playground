import type {
  AgentExecutionRoute,
  AgentRouteDecision,
  FinalOutputSpec,
  InputImage,
  TaskParams,
  TaskRecord,
} from '../types'
import {
  clearComposerDraft,
  getComposerDraftSnapshot,
  updateTaskInStore,
  useStore,
  type ComposerDraftSnapshot,
} from '../store'
import { getImage, putTask, storeImage } from './db'
import { createAgentConversationId, getAgentConversationId, getConversationTasks } from './agentConversation'
import { routeAgentTurn } from './agentRoute'
import { createAutoPipeline } from './restrictedAgentApi'
import {
  cancelAutoPipelineTaskExecution,
  createRestrictedAgentPlanRequestFromDraft,
  observeAutoPipelineExecution,
} from '../restrictedAgentStore'
import { cancelAgentTask, retryAgentTask, storeBackedAgentExecutor } from './legacyAgentExecutor'
import { getAgentCapabilities, isRestrictedAgentEnabled } from './serverApiConfig'

export interface UnifiedAgentTurnRequest {
  conversationId?: string | null
  /** 未提供时使用统一 Agent Composer 的冻结 prompt。 */
  prompt?: string
  /** 未提供时使用统一 Agent Composer 的显式图片绑定。 */
  inputImageIds?: string[]
  params?: TaskParams
  stream?: boolean
  imageCount?: number
  /** 重试和测试可显式传入已冻结的 Composer 快照。 */
  draftSnapshot?: ComposerDraftSnapshot
}

interface PreparedUnifiedTurn {
  conversationId: string
  turn: number
  draft: ComposerDraftSnapshot
  decision: AgentRouteDecision
  stream: boolean
  imageCount: number
}

const conversationSubmissionQueues = new Map<string, Promise<void>>()
const cancelledPendingPipelineTasks = new Set<string>()

function normalizeImageCount(value: number | undefined) {
  return Math.min(4, Math.max(1, Math.round(value || 1)))
}

function createTaskId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `agent-unified-${crypto.randomUUID()}`
  }
  return `agent-unified-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function withConversationSubmissionLock<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
  const previous = conversationSubmissionQueues.get(conversationId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.catch(() => undefined).then(() => current)
  conversationSubmissionQueues.set(conversationId, queued)

  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (conversationSubmissionQueues.get(conversationId) === queued) {
      conversationSubmissionQueues.delete(conversationId)
    }
  }
}

function cloneDraft(snapshot: ComposerDraftSnapshot): ComposerDraftSnapshot {
  return {
    ...snapshot,
    composerScope: 'agent',
    inputImages: snapshot.inputImages.map((image) => ({ ...image })),
    maskDraft: snapshot.maskDraft ? { ...snapshot.maskDraft } : null,
    params: { ...snapshot.params },
  }
}

function resolveDraft(request: UnifiedAgentTurnRequest): ComposerDraftSnapshot | null {
  const base = cloneDraft(request.draftSnapshot ?? getComposerDraftSnapshot('agent'))
  const prompt = request.prompt === undefined ? base.prompt : request.prompt
  const params = request.params ? { ...request.params } : base.params
  let inputImages = base.inputImages
  if (request.inputImageIds) {
    const byId = new Map(base.inputImages.map((image) => [image.id, image]))
    const selected = request.inputImageIds.map((id) => byId.get(id)).filter((image): image is InputImage => Boolean(image))
    if (selected.length !== request.inputImageIds.length) {
      useStore.getState().showToast('指定的 Agent 输入图片已不存在，请重新选择', 'error')
      return null
    }
    inputImages = selected.map((image) => ({ ...image }))
  }
  return {
    ...base,
    prompt,
    params,
    inputImages,
    // 重试快照显式使用 -1；当前 Composer 快照保留版本，清理函数会再做 CAS。
    composerVersion: base.composerVersion,
  }
}

function isResponsesAvailable() {
  return Boolean(getAgentCapabilities(useStore.getState().settings).responsesUsable)
}

function prepareTurn(
  request: UnifiedAgentTurnRequest,
  decisionOverride?: AgentRouteDecision,
): PreparedUnifiedTurn | null {
  const draft = resolveDraft(request)
  if (!draft) return null
  const conversationId = request.conversationId?.trim() || createAgentConversationId()
  const tasks = useStore.getState().tasks
  return {
    conversationId,
    turn: getConversationTasks(tasks, conversationId).length + 1,
    draft,
    decision: decisionOverride ?? routeAgentTurn({
      prompt: draft.prompt,
      hasExplicitImageInput: draft.inputImages.length > 0,
      inputImageIds: draft.inputImages.map((image) => image.id),
    }),
    stream: request.stream ?? useStore.getState().settings.agentStreaming,
    imageCount: normalizeImageCount(request.imageCount ?? useStore.getState().settings.agentImageCount),
  }
}

async function materializeTurnInputs(draft: ComposerDraftSnapshot) {
  const inputImageIds = await Promise.all(draft.inputImages.map(async (image) => ({
    originalId: image.id,
    storedId: await storeImage(image.dataUrl, 'upload'),
  })))
  const inputIdByOriginalId = new Map(inputImageIds.map((item) => [item.originalId, item.storedId]))
  const maskImageId = draft.maskDraft
    ? await storeImage(draft.maskDraft.maskDataUrl, 'mask')
    : null
  return {
    inputImageIds: inputImageIds.map((item) => item.storedId),
    maskTargetImageId: draft.maskDraft
      ? inputIdByOriginalId.get(draft.maskDraft.targetImageId) ?? null
      : null,
    maskImageId,
  }
}

function getExecutionRoute(plan: { actions: Array<{ type: string }> }): AgentExecutionRoute {
  const first = plan.actions[0]
  if (first?.type === 'image.edit') return 'gateway_image_edit'
  if (first?.type === 'image.transform') return 'image_transform'
  return 'gateway_image_generate'
}

function createTaskRecord(
  prepared: PreparedUnifiedTurn,
  inputImageIds: string[],
  maskTargetImageId: string | null,
  maskImageId: string | null,
  status: TaskRecord['status'] = 'running',
): TaskRecord {
  const now = Date.now()
  return {
    id: createTaskId(),
    prompt: prepared.draft.prompt.trim(),
    params: {
      ...prepared.draft.params,
      n: prepared.decision.route === 'tool_pipeline' ? 1 : prepared.imageCount,
    },
    apiProvider: prepared.decision.route === 'tool_pipeline' ? 'restricted-agent' : undefined,
    apiProfileName: prepared.decision.route === 'tool_pipeline' ? '受限 Agent Gateway' : undefined,
    inputImageIds,
    maskTargetImageId,
    maskImageId,
    outputImages: [],
    status,
    error: null,
    createdAt: now,
    finishedAt: status === 'running' ? null : now,
    elapsed: status === 'running' ? null : 0,
    origin: 'agent',
    agentConversationId: prepared.conversationId,
    agentTurn: prepared.turn,
    agentRoute: prepared.decision.route,
    agentRouteReason: prepared.decision.routeReason,
    agentHardConstraints: [...prepared.decision.hardConstraints],
    agentFallbackForbidden: prepared.decision.fallbackForbidden,
    ...(prepared.decision.finalOutputSpec ? { agentFinalOutputSpec: { ...prepared.decision.finalOutputSpec } } : {}),
    agentOriginalRequest: prepared.draft.prompt.trim(),
  }
}

async function insertTurnTask(task: TaskRecord) {
  const state = useStore.getState()
  state.setTasks([task, ...state.tasks.filter((item) => item.id !== task.id)])
  try {
    await putTask(task)
  } catch (error) {
    state.setTasks(state.tasks.filter((item) => item.id !== task.id))
    throw error
  }
}

function failTurnTask(taskId: string, message: string) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task) return
  const finishedAt = Date.now()
  updateTaskInStore(taskId, {
    status: 'error',
    error: message,
    finishedAt,
    elapsed: Math.max(0, finishedAt - task.createdAt),
  })
}

async function createTextTurn(prepared: PreparedUnifiedTurn) {
  const task = createTaskRecord(prepared, prepared.draft.inputImages.map((image) => image.id), null, null, 'done')
  task.agentAssistantText = prepared.decision.routeReason
  await insertTurnTask(task)
  return task.id
}

async function submitToolPipeline(prepared: PreparedUnifiedTurn) {
  let inputs: Awaited<ReturnType<typeof materializeTurnInputs>>
  try {
    inputs = await materializeTurnInputs(prepared.draft)
  } catch (error) {
    useStore.getState().showToast(`保存 Agent 输入失败：${getErrorMessage(error)}`, 'error')
    return null
  }
  const task = createTaskRecord(prepared, inputs.inputImageIds, inputs.maskTargetImageId, inputs.maskImageId)
  try {
    await insertTurnTask(task)
  } catch (error) {
    useStore.getState().showToast(`创建 Agent 回合失败：${getErrorMessage(error)}`, 'error')
    return null
  }

  if (!isRestrictedAgentEnabled()) {
    failTurnTask(task.id, '严格图片规格需要 Tool Pipeline，但当前 Gateway 不可用；不会改用近似的 Responses 生成。')
    return task.id
  }
  if (!prepared.decision.finalOutputSpec) {
    failTurnTask(task.id, '当前严格要求缺少可执行的最终输出规格，请补充像素尺寸、格式或明确的处理参数。')
    return task.id
  }

  cancelledPendingPipelineTasks.delete(task.id)
  try {
    const pipeline = await createAutoPipeline({
      ...createRestrictedAgentPlanRequestFromDraft(prepared.draft),
      imageCount: 1,
      finalOutputSpec: prepared.decision.finalOutputSpec,
    })
    updateTaskInStore(task.id, {
      agentPlanId: pipeline.plan.id,
      agentPlanSnapshot: pipeline.plan,
      agentExecutionId: pipeline.execution.id,
      agentExecutionSnapshot: pipeline.execution,
      agentExecutionRoute: getExecutionRoute(pipeline.plan),
    })
    observeAutoPipelineExecution(task.id, pipeline)
    clearComposerDraft('agent', prepared.draft.composerVersion, useStore.getState().settings.clearInputAfterSubmit)
    if (cancelledPendingPipelineTasks.delete(task.id)) {
      await cancelAutoPipelineTaskExecution(task.id)
    }
  } catch (error) {
    if (!cancelledPendingPipelineTasks.delete(task.id)) {
      failTurnTask(task.id, `严格图片规格无法保证：${getErrorMessage(error)}`)
    }
  }
  return task.id
}

async function submitPreparedTurn(prepared: PreparedUnifiedTurn): Promise<string | null> {
  if (prepared.decision.route === 'tool_pipeline') return submitToolPipeline(prepared)
  if (prepared.decision.route === 'clarify' || prepared.decision.route === 'unsupported') {
    return createTextTurn(prepared)
  }

  const taskId = await storeBackedAgentExecutor.submit({
    prompt: prepared.draft.prompt,
    inputImageIds: prepared.draft.inputImages.map((image) => image.id),
    params: { ...prepared.draft.params },
    stream: prepared.stream,
    imageCount: prepared.imageCount,
    conversationId: prepared.conversationId,
  })
  if (!taskId) return null
  updateTaskInStore(taskId, {
    origin: 'agent',
    agentConversationId: prepared.conversationId,
    agentTurn: prepared.turn,
    agentRoute: prepared.decision.route,
    agentRouteReason: prepared.decision.routeReason,
    agentHardConstraints: [...prepared.decision.hardConstraints],
    agentFallbackForbidden: false,
    agentExecutionRoute: 'responses_image',
    agentOriginalRequest: prepared.draft.prompt.trim(),
  })
  return taskId
}

async function submitUnifiedAgentTurnInternal(
  request: UnifiedAgentTurnRequest,
  decisionOverride?: AgentRouteDecision,
): Promise<string | null> {
  if (!isResponsesAvailable()) {
    useStore.getState().showToast('Agent 当前不可用：Responses 服务不可用，Tool Pipeline 也不会单独启用。', 'error')
    return null
  }
  const prepared = prepareTurn(request, decisionOverride)
  if (!prepared) return null
  return withConversationSubmissionLock(prepared.conversationId, async () => {
    // 等待前一个同会话提交完成后重新计算 turn，避免 Responses 与 Gateway 交错重复编号。
    const current = prepareTurn({ ...request, draftSnapshot: prepared.draft, conversationId: prepared.conversationId }, decisionOverride)
    if (!current) return null
    return submitPreparedTurn(current)
  })
}

/** 单一 Agent 的提交入口；路由决定实际执行器，用户不需要选择模式。 */
export function submitUnifiedAgentTurn(request: UnifiedAgentTurnRequest = {}): Promise<string | null> {
  return submitUnifiedAgentTurnInternal(request)
}

function getRetryDecision(task: TaskRecord): AgentRouteDecision {
  if (task.agentRoute) {
    return {
      route: task.agentRoute,
      routeReason: task.agentRouteReason ?? '复用该回合冻结的 Agent 路由。',
      hardConstraints: [...(task.agentHardConstraints ?? [])],
      fallbackForbidden: Boolean(task.agentFallbackForbidden),
      finalOutputSpec: task.agentFinalOutputSpec ? { ...task.agentFinalOutputSpec } : null,
    }
  }
  return routeAgentTurn({ prompt: task.agentOriginalRequest ?? task.prompt, inputImageIds: task.inputImageIds })
}

async function buildRetryDraft(task: TaskRecord): Promise<ComposerDraftSnapshot | null> {
  const images = await Promise.all(task.inputImageIds.map(async (id) => getImage(id)))
  if (images.some((image) => !image)) {
    useStore.getState().showToast('原回合的显式输入图片已不存在，无法安全重试。', 'error')
    return null
  }
  let maskDraft: ComposerDraftSnapshot['maskDraft'] = null
  if (task.maskImageId && task.maskTargetImageId) {
    const mask = await getImage(task.maskImageId)
    if (!mask) {
      useStore.getState().showToast('原回合的遮罩图片已不存在，无法安全重试。', 'error')
      return null
    }
    maskDraft = { targetImageId: task.maskTargetImageId, maskDataUrl: mask.dataUrl, updatedAt: Date.now() }
  }
  const current = getComposerDraftSnapshot('agent')
  return {
    ...current,
    composerScope: 'agent',
    prompt: task.agentOriginalRequest ?? task.prompt,
    inputImages: images.map((image) => ({ id: image!.id, dataUrl: image!.dataUrl })),
    maskDraft,
    params: { ...task.params },
    composerVersion: -1,
  }
}

/** 重试始终创建同一会话的下一轮；严格回合继续使用冻结的规格与显式输入。 */
export async function retryUnifiedAgentTask(task: TaskRecord): Promise<string | null> {
  if (task.origin !== 'agent') return retryAgentTask(task)
  const decision = getRetryDecision(task)
  if (decision.route === 'responses_image') {
    const taskId = await retryAgentTask(task)
    if (taskId) {
      updateTaskInStore(taskId, {
        agentRoute: 'responses_image',
        agentRouteReason: decision.routeReason,
        agentHardConstraints: [],
        agentFallbackForbidden: false,
        agentExecutionRoute: 'responses_image',
      })
    }
    return taskId
  }
  const draft = await buildRetryDraft(task)
  if (!draft) return null
  return submitUnifiedAgentTurnInternal({
    conversationId: getAgentConversationId(task),
    draftSnapshot: draft,
  }, decision)
}

/** 取消只作用于该 task 绑定的执行，不影响同页其他 Agent 回合。 */
export async function cancelUnifiedAgentTask(task: TaskRecord): Promise<boolean> {
  if (task.agentPlanSnapshot?.schemaVersion === 3 || task.agentExecutionId) {
    if (!task.agentExecutionId) {
      cancelledPendingPipelineTasks.add(task.id)
      failTurnTask(task.id, '执行已取消')
      return true
    }
    return cancelAutoPipelineTaskExecution(task.id)
  }
  return cancelAgentTask(task.id)
}

/** 供结果卡渲染 action 进度的轻量辅助，避免 UI 识别 Gateway action 标识。 */
export function getUnifiedAgentExecutionSummary(task: TaskRecord): string | null {
  const action = task.agentExecutionSnapshot?.actions?.find((item) => item.status === 'executing')
    ?? task.agentExecutionSnapshot?.actions?.find((item) => item.status === 'queued')
  if (!action) return null
  if (action.type === 'metadata.assert') return '正在校验输出规格'
  if (action.type === 'image.transform') return '正在严格处理图片'
  if (action.type === 'image.edit') return '正在编辑图片'
  return '正在生成图片'
}

export function getFrozenFinalOutputSpec(task: TaskRecord): FinalOutputSpec | null {
  return task.agentFinalOutputSpec ? { ...task.agentFinalOutputSpec } : null
}

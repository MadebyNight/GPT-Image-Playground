import type { ApiProfile, ResponsesApiResponse, TaskParams, TaskRecord } from '../types'
import { retryTaskWithExecution, submitTask, useStore } from '../store'
import { buildAgentConversationContext, createAgentConversationId, getAgentConversationId, getConversationTasks } from './agentConversation'
import { getActiveApiProfile } from './apiProfiles'
import { routeAgentTurn } from './agentRoute'
import { buildOpenAIRequestUrl, createRequestHeaders, createResponsesImageTool, parseResponsesImageResults } from './openaiCompatibleImageApi'
import { readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import {
  assertImageInputPayloadSize,
  assertMaskEditFileSize,
  type CallApiOptions,
  type CallApiResult,
  getApiErrorMessage,
  getDataUrlDecodedByteSize,
  getDataUrlEncodedByteSize,
  mergeActualParams,
  MIME_MAP,
  normalizeBase64Image,
} from './imageApiShared'
import { getChatCapabilities } from './serverApiConfig'

export interface AgentGenerationRequest {
  prompt: string
  inputImageIds: string[]
  params: TaskParams
  stream: boolean
  imageCount: number
  /** 为空时开始一段新会话。 */
  conversationId?: string | null
}

export type AgentToolStatus = 'queued' | 'in_progress' | 'generating' | 'completed'

export type AgentProgressEvent =
  | { type: 'task_created'; taskId: string; prompt: string; imageCount: number; stream: boolean }
  | { type: 'assistant_delta'; taskId?: string; text: string }
  | { type: 'tool_status'; taskId?: string; status: AgentToolStatus; message: string }
  | { type: 'partial_image'; taskId?: string; image: string; index?: number }
  | { type: 'done'; taskId?: string; imageCount: number; revisedPrompts?: Array<string | undefined>; assistantText?: string }
  | { type: 'error'; taskId?: string; message: string }

export interface AgentExecutor {
  submit(request: AgentGenerationRequest): Promise<string | null>
}

const agentEvents = new EventTarget()
const activeAgentControllers = new Map<string, Set<AbortController>>()
const cancelledAgentTaskIds = new Set<string>()
const conversationSubmissionQueues = new Map<string, Promise<void>>()

class AgentResponseError extends Error {
  readonly agentAssistantText?: string

  constructor(message: string, options: { cause?: unknown; agentAssistantText?: string } = {}) {
    super(message)
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: options.cause, configurable: true })
    }
    this.name = options.cause instanceof Error ? options.cause.name : 'AgentResponseError'
    this.agentAssistantText = options.agentAssistantText?.trim() || undefined
  }
}

function getErrorAssistantText(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = (error as { agentAssistantText?: unknown }).agentAssistantText
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function withAgentAssistantText(error: unknown, assistantText: string | undefined, message?: string): Error {
  const text = assistantText?.trim()
  const errorMessage = message ?? (error instanceof Error ? error.message : String(error))
  if (!text && !message) return error instanceof Error ? error : new Error(errorMessage)
  return new AgentResponseError(errorMessage, { cause: error, ...(text ? { agentAssistantText: text } : {}) })
}

function registerAgentController(taskId: string | undefined, controller: AbortController) {
  if (!taskId) return
  const controllers = activeAgentControllers.get(taskId) ?? new Set<AbortController>()
  controllers.add(controller)
  activeAgentControllers.set(taskId, controllers)
}

function unregisterAgentController(taskId: string | undefined, controller: AbortController) {
  if (!taskId) return
  const controllers = activeAgentControllers.get(taskId)
  controllers?.delete(controller)
  if (!controllers?.size) activeAgentControllers.delete(taskId)
}

export function cancelAgentTask(taskId: string): boolean {
  const controllers = activeAgentControllers.get(taskId)
  if (!controllers?.size) return false
  cancelledAgentTaskIds.add(taskId)
  for (const controller of controllers) controller.abort()
  return true
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

export function subscribeAgentProgress(listener: (event: AgentProgressEvent) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<AgentProgressEvent>).detail)
  agentEvents.addEventListener('agent-progress', handler)
  return () => agentEvents.removeEventListener('agent-progress', handler)
}

function emitAgentProgress(event: AgentProgressEvent) {
  agentEvents.dispatchEvent(new CustomEvent('agent-progress', { detail: event }))
}

function getAgentImageCount(value: number): number {
  return Math.min(4, Math.max(1, Math.round(value || 1)))
}

function normalizeSubmittedPrompt(value: string): string {
  return value.trim()
}

function createAgentResponsesInput(prompt: string, inputImageDataUrls: string[], conversationContext?: string | null): unknown {
  const requestText = conversationContext?.trim()
    ? `${conversationContext.trim()}\n\n本轮请求：\n${prompt}`
    : prompt
  if (!inputImageDataUrls.length) return requestText

  return [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: requestText },
        ...inputImageDataUrls.map((dataUrl) => ({
          type: 'input_image',
          image_url: dataUrl,
        })),
      ],
    },
  ]
}

function getSseDataLines(chunk: string): string[] {
  return chunk
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
}

function getEventTextDelta(event: Record<string, unknown>): string {
  return typeof event.delta === 'string' ? event.delta : ''
}

function getResponseFailureMessage(event: Record<string, unknown>): string | null {
  if (typeof event.message === 'string' && event.message.trim()) return event.message.trim()
  const candidates = [event.error, event.response]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const record = candidate as Record<string, unknown>
    if (typeof record.message === 'string' && record.message.trim()) return record.message.trim()
    if (record.error && typeof record.error === 'object') {
      const message = (record.error as Record<string, unknown>).message
      if (typeof message === 'string' && message.trim()) return message.trim()
    }
  }
  return null
}

function getResponsesOutputText(payload: ResponsesApiResponse): string | undefined {
  const texts: string[] = []

  for (const output of payload.output ?? []) {
    const item = output as unknown as Record<string, unknown>
    if (typeof item.text === 'string' && item.text.trim()) texts.push(item.text)

    if (!Array.isArray(item.content)) continue
    for (const content of item.content) {
      if (!content || typeof content !== 'object') continue
      const contentItem = content as Record<string, unknown>
      if (contentItem.type === 'output_text' && typeof contentItem.text === 'string' && contentItem.text.trim()) {
        texts.push(contentItem.text)
      }
    }
  }

  const result = texts.join('\n').trim()
  return result || undefined
}

function getEventPartialImage(event: Record<string, unknown>): string | null {
  const raw =
    typeof event.partial_image_b64 === 'string' ? event.partial_image_b64 :
    typeof event.partial_image === 'string' ? event.partial_image :
    typeof event.result === 'string' ? event.result :
    null
  return raw?.trim() ? normalizeBase64Image(raw, 'image/png') : null
}

function getImageGenerationStatus(eventType: string): AgentToolStatus | null {
  if (!eventType.includes('image_generation_call')) return null
  if (eventType.endsWith('.completed')) return 'completed'
  if (eventType.endsWith('.generating')) return 'generating'
  if (eventType.endsWith('.in_progress')) return 'in_progress'
  return null
}

function getToolStatusMessage(status: AgentToolStatus, index: number, total: number): string {
  const prefix = total > 1 ? `第 ${index + 1}/${total} 张：` : ''
  if (status === 'completed') return `${prefix}图像工具调用完成`
  if (status === 'generating') return `${prefix}图像生成中`
  if (status === 'in_progress') return `${prefix}正在调用图像工具`
  return `${prefix}已排队等待图像工具`
}

async function readResponsesStream(
  response: Response,
  fallbackMime: string,
  taskId: string | undefined,
  index: number,
  total: number,
): Promise<CallApiResult> {
  if (!response.body) throw new Error('接口没有返回可读取的流')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completedPayload: ResponsesApiResponse | null = null
  let assistantText = ''
  const handleData = (data: string): Error | null => {
    if (data === '[DONE]') return null
    let event: Record<string, unknown>
    try {
      event = JSON.parse(data) as Record<string, unknown>
    } catch {
      return null
    }

    const eventType = typeof event.type === 'string' ? event.type : ''
    if (eventType === 'response.output_text.delta') {
      const text = getEventTextDelta(event)
      if (text) {
        assistantText += text
        emitAgentProgress({ type: 'assistant_delta', taskId, text })
      }
    }

    const status = getImageGenerationStatus(eventType)
    if (status) {
      emitAgentProgress({
        type: 'tool_status',
        taskId,
        status,
        message: getToolStatusMessage(status, index, total),
      })
    }

    if (eventType.endsWith('.partial_image')) {
      const image = getEventPartialImage(event)
      if (image) emitAgentProgress({ type: 'partial_image', taskId, image, index })
    }

    if (eventType === 'response.completed' && event.response && typeof event.response === 'object') {
      completedPayload = event.response as ResponsesApiResponse
    }
    if (eventType === 'response.failed') {
      return new Error(getResponseFailureMessage(event) ?? 'Responses API 返回失败状态')
    }
    if (eventType === 'error') return new Error(getResponseFailureMessage(event) ?? 'Responses API 返回错误事件')
    return null
  }
  const handleSseData = async (data: string) => {
    const terminalError = handleData(data)
    if (!terminalError) return
    try {
      await reader.cancel()
    } catch {
      // 终止事件本身优先；reader cancel 失败不能掩盖上游错误。
    }
    throw terminalError
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ''

      for (const block of blocks) {
        for (const data of getSseDataLines(block)) {
          await handleSseData(data)
        }
      }
    }

    for (const data of getSseDataLines(buffer)) {
      await handleSseData(data)
    }

    if (!completedPayload) throw new Error('流式响应结束但没有返回完整结果')
    const imageResults = parseResponsesImageResults(completedPayload, fallbackMime)
    const finalAssistantText = assistantText.trim() || getResponsesOutputText(completedPayload)
    return {
      images: imageResults.map((result) => result.image),
      actualParams: mergeActualParams(imageResults[0]?.actualParams ?? {}),
      actualParamsList: imageResults.map((result) => mergeActualParams(result.actualParams ?? {})),
      revisedPrompts: imageResults.map((result) => result.revisedPrompt),
      ...(finalAssistantText ? { assistantText: finalAssistantText } : {}),
    }
  } catch (error) {
    throw withAgentAssistantText(error, assistantText)
  }
}

function assertAgentProfile(profile: ApiProfile) {
  if (profile.provider !== 'openai' || profile.apiMode !== 'responses') {
    throw new Error('Agent 模式需要使用 OpenAI 兼容的 Responses API 配置')
  }
}

/**
 * 旧 Responses 执行器只允许承接没有严格规格的回合。严格规格会由统一执行器
 * 转交 Gateway；这里的断言防止旧调用方绕过前端分流而产生错误的 Responses 回退。
 */
function assertResponsesAgentRoute(opts: CallApiOptions) {
  const decision = routeAgentTurn({
    prompt: opts.prompt,
    hasExplicitImageInput: opts.inputImageDataUrls.length > 0,
  })
  if (decision.route !== 'responses_image') {
    throw new Error(`当前 Agent 回合不能通过 Responses 执行：${decision.routeReason}`)
  }
}

async function callAgentResponsesImageApiSingle(
  opts: CallApiOptions,
  profile: ApiProfile,
  stream: boolean,
  taskId: string | undefined,
  index: number,
  total: number,
): Promise<CallApiResult> {
  const { prompt, params, inputImageDataUrls } = opts
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const requestHeaders = createRequestHeaders(profile)
  const controller = new AbortController()
  let timedOut = false
  registerAgentController(taskId, controller)
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, profile.timeout * 1000)

  try {
    if (opts.maskDataUrl) {
      assertMaskEditFileSize('遮罩主图文件', getDataUrlDecodedByteSize(inputImageDataUrls[0] ?? ''))
      assertMaskEditFileSize('遮罩文件', getDataUrlDecodedByteSize(opts.maskDataUrl))
    }
    assertImageInputPayloadSize(
      inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0) +
        (opts.maskDataUrl ? getDataUrlEncodedByteSize(opts.maskDataUrl) : 0),
    )

    emitAgentProgress({ type: 'tool_status', taskId, status: 'queued', message: getToolStatusMessage('queued', index, total) })

    const body = {
      model: profile.model,
      input: createAgentResponsesInput(prompt, inputImageDataUrls, opts.agentConversationContext),
      tools: [createResponsesImageTool(params, inputImageDataUrls.length > 0, profile, opts.maskDataUrl)],
      tool_choice: 'required',
      ...(stream ? { stream: true } : {}),
    }

    const response = await fetch(buildOpenAIRequestUrl(profile, 'responses', proxyConfig, useApiProxy), {
      method: 'POST',
      headers: {
        ...requestHeaders,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response))
    }

    if (stream) return await readResponsesStream(response, mime, taskId, index, total)

    emitAgentProgress({ type: 'tool_status', taskId, status: 'in_progress', message: getToolStatusMessage('in_progress', index, total) })
    const payload = await response.json() as ResponsesApiResponse
    const imageResults = parseResponsesImageResults(payload, mime)
    const assistantText = getResponsesOutputText(payload)
    emitAgentProgress({ type: 'tool_status', taskId, status: 'completed', message: getToolStatusMessage('completed', index, total) })
    return {
      images: imageResults.map((result) => result.image),
      actualParams: mergeActualParams(imageResults[0]?.actualParams ?? {}),
      actualParamsList: imageResults.map((result) => mergeActualParams(result.actualParams ?? {})),
      revisedPrompts: imageResults.map((result) => result.revisedPrompt),
      ...(assistantText ? { assistantText } : {}),
    }
  } catch (error) {
    if (controller.signal.aborted) {
      const cancelled = Boolean(taskId && cancelledAgentTaskIds.has(taskId))
      const message = cancelled
        ? 'Agent 请求已取消'
        : timedOut
          ? `请求超时：超过 ${profile.timeout} 秒仍未完成。`
          : error instanceof Error ? error.message : String(error)
      throw withAgentAssistantText(error, getErrorAssistantText(error), message)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
    unregisterAgentController(taskId, controller)
  }
}

export async function callAgentResponsesImageApi(
  opts: CallApiOptions,
  options: { stream: boolean; imageCount: number; taskId?: string } = { stream: true, imageCount: 1 },
): Promise<CallApiResult> {
  assertResponsesAgentRoute(opts)
  const profile = getActiveApiProfile(opts.settings)
  assertAgentProfile(profile)

  const imageCount = getAgentImageCount(options.imageCount)
  const singleOpts = { ...opts, params: { ...opts.params, n: 1 } }
  const results: CallApiResult[] = []
  try {
    for (let index = 0; index < imageCount; index += 1) {
      try {
        results.push(await callAgentResponsesImageApiSingle(singleOpts, profile, options.stream, options.taskId, index, imageCount))
      } catch (error) {
        const assistantText = [
          ...results.map((result) => result.assistantText?.trim()).filter((text): text is string => Boolean(text)),
          getErrorAssistantText(error),
        ].filter((text): text is string => Boolean(text)).join('\n')
        throw withAgentAssistantText(error, assistantText)
      }
    }
  } finally {
    if (options.taskId) cancelledAgentTaskIds.delete(options.taskId)
  }

  const images = results.flatMap((result) => result.images)
  const actualParamsList = results.flatMap((result) =>
    result.actualParamsList?.length ? result.actualParamsList : result.images.map(() => result.actualParams),
  )
  const revisedPrompts = results.flatMap((result) =>
    result.revisedPrompts?.length ? result.revisedPrompts : result.images.map(() => undefined),
  )
  const assistantTexts = results
    .map((result) => result.assistantText?.trim())
    .filter((text): text is string => Boolean(text))
  const assistantText = assistantTexts[assistantTexts.length - 1]
  const actualParams = mergeActualParams(results[0]?.actualParams ?? {}, { n: images.length })

  emitAgentProgress({
    type: 'done',
    taskId: options.taskId,
    imageCount: images.length,
    revisedPrompts,
    assistantText,
  })

  return { images, actualParams, actualParamsList, revisedPrompts, ...(assistantText ? { assistantText } : {}) }
}

export const storeBackedAgentExecutor: AgentExecutor = {
  async submit(request) {
    const state = useStore.getState()
    const currentInputImageIds = state.inputImages.map((image) => image.id)
    const sameInputImages =
      currentInputImageIds.length === request.inputImageIds.length &&
      currentInputImageIds.every((id, index) => id === request.inputImageIds[index])

    if (!sameInputImages) {
      state.showToast('Agent 请求与当前输入图片不一致，未提交任务', 'error')
      return null
    }

    const conversationId = request.conversationId?.trim() || createAgentConversationId()
    const imageCount = getAgentImageCount(request.imageCount)
    const draftMatchesCurrentPrompt = normalizeSubmittedPrompt(state.prompt) === normalizeSubmittedPrompt(request.prompt)
    const draftSnapshot = {
      composerScope: state.composerScope,
      prompt: request.prompt,
      inputImages: state.inputImages.map((image) => ({ ...image })),
      maskDraft: state.maskDraft ? { ...state.maskDraft } : null,
      params: { ...request.params, n: imageCount },
      reusedTaskApiProfileId: state.reusedTaskApiProfileId,
      reusedTaskApiProfileName: state.reusedTaskApiProfileName,
      reusedTaskApiProfileMissing: state.reusedTaskApiProfileMissing,
      composerVersion: draftMatchesCurrentPrompt ? state.composerVersion : -1,
    }

    return withConversationSubmissionLock(conversationId, async () => {
      const latestState = useStore.getState()
      const existingTasks = latestState.tasks ?? []
      const conversationContext = buildAgentConversationContext(existingTasks, conversationId)
      const turn = getConversationTasks(existingTasks, conversationId).length + 1

      let taskId: string | undefined
      return submitTask({
        draftSnapshot,
        callApi: (opts) => callAgentResponsesImageApi({ ...opts, agentConversationContext: conversationContext }, {
          stream: request.stream,
          imageCount,
          taskId,
        }),
        onTaskCreated: (createdTaskId) => {
          taskId = createdTaskId
          emitAgentProgress({
            type: 'task_created',
            taskId,
            prompt: request.prompt,
            imageCount,
            stream: request.stream,
          })
        },
        taskMetadata: {
          origin: 'agent',
          agentConversationId: conversationId,
          agentTurn: turn,
        },
      })
    })
  },
}

export async function retryAgentTask(task: TaskRecord): Promise<string | null> {
  if (task.origin !== 'agent') return retryTaskWithExecution(task)

  const conversationId = getAgentConversationId(task)
  return withConversationSubmissionLock(conversationId, async () => {
    const state = useStore.getState()
    const capabilities = getChatCapabilities(state.settings)
    if (!capabilities.chatUsable) {
      state.showToast(
        capabilities.chatAllowed && !capabilities.chatConfigured
          ? 'Agent 模式需要使用 OpenAI 兼容的 Responses API 配置'
          : '当前 Chat API 配置不可用',
        'error',
      )
      if (capabilities.chatAllowed) state.setShowSettings(true)
      return null
    }

    const existingTasks = state.tasks ?? []
    const conversationContext = buildAgentConversationContext(existingTasks, conversationId)
    const turn = getConversationTasks(existingTasks, conversationId).length + 1
    const imageCount = getAgentImageCount(task.params.n)
    const stream = state.settings.agentStreaming
    let taskId: string | undefined

    return retryTaskWithExecution(task, {
      callApi: (opts) => callAgentResponsesImageApi({ ...opts, agentConversationContext: conversationContext }, {
        stream,
        imageCount,
        taskId,
      }),
      onTaskCreated: (createdTaskId) => {
        taskId = createdTaskId
        emitAgentProgress({
          type: 'task_created',
          taskId,
          prompt: task.prompt,
          imageCount,
          stream,
        })
      },
      taskMetadata: {
        origin: 'agent',
        agentConversationId: conversationId,
        agentTurn: turn,
      },
    })
  })
}

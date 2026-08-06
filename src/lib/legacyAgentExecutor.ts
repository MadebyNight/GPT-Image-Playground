import type { ApiProfile, ResponsesApiResponse, TaskParams } from '../types'
import { submitTask, useStore } from '../store'
import { buildAgentConversationContext, createAgentConversationId, getConversationTasks } from './agentConversation'
import { getActiveApiProfile } from './apiProfiles'
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
  const handleData = (data: string) => {
    if (data === '[DONE]') return
    let event: Record<string, unknown>
    try {
      event = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
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
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() ?? ''

    for (const block of blocks) {
      for (const data of getSseDataLines(block)) {
        handleData(data)
      }
    }
  }

  for (const data of getSseDataLines(buffer)) {
    handleData(data)
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
}

function assertAgentProfile(profile: ApiProfile) {
  if (profile.provider !== 'openai' || profile.apiMode !== 'responses') {
    throw new Error('Agent 模式需要使用 OpenAI 兼容的 Responses API 配置')
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
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)

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

    if (stream) return readResponsesStream(response, mime, taskId, index, total)

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
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function callAgentResponsesImageApi(
  opts: CallApiOptions,
  options: { stream: boolean; imageCount: number; taskId?: string } = { stream: true, imageCount: 1 },
): Promise<CallApiResult> {
  const profile = getActiveApiProfile(opts.settings)
  assertAgentProfile(profile)

  const imageCount = getAgentImageCount(options.imageCount)
  const singleOpts = { ...opts, params: { ...opts.params, n: 1 } }
  const results: CallApiResult[] = []

  for (let index = 0; index < imageCount; index += 1) {
    results.push(await callAgentResponsesImageApiSingle(singleOpts, profile, options.stream, options.taskId, index, imageCount))
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

    const imageCount = getAgentImageCount(request.imageCount)
    state.setPrompt(request.prompt)
    state.setParams({ ...request.params, n: imageCount })

    const conversationId = request.conversationId?.trim() || createAgentConversationId()
    const existingTasks = state.tasks ?? []
    const conversationContext = buildAgentConversationContext(existingTasks, conversationId)
    const turn = getConversationTasks(existingTasks, conversationId).length + 1

    let taskId: string | undefined
    const result = await submitTask({
      callApi: (opts) => callAgentResponsesImageApi({ ...opts, agentConversationContext: conversationContext }, {
        stream: request.stream,
        imageCount,
        taskId,
      }).catch((err) => {
        emitAgentProgress({ type: 'error', taskId, message: err instanceof Error ? err.message : String(err) })
        throw err
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
    return result
  },
}

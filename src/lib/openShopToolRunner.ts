import type { TaskRecord } from '../types'
import { ensureImageCached, saveOpenShopEdit, useStore } from '../store'
import {
  OPENSHOP_TOOL_COMMAND_IDS,
  OPENSHOP_TOOL_MAX_IMAGE_PIXELS,
  OPENSHOP_TOOL_MAX_COMMANDS,
  blobHasExpectedImageMagic,
  createOpenShopRequestId,
  dataUrlToOpenShopDocument,
  getOpenShopFrameUrl,
  getOpenShopTargetOrigin,
  isOpenShopToolResponseMessage,
  normalizeOpenShopToolCommands,
  postOpenShopToolMessage,
  type OpenShopCanvasCommand,
  type OpenShopDocument,
  type OpenShopToolDocumentDescriptor,
  type OpenShopToolErrorCode,
  type OpenShopToolErrorMessage,
  type OpenShopToolExportedMessage,
  type OpenShopToolRequestMessage,
  type OpenShopToolResponseMessage,
} from './openshopBridge'

export const OPENSHOP_TOOL_TIMEOUTS = Object.freeze({
  handshakeMs: 5_000,
  configureMs: 30_000,
  executeMs: 20_000,
  exportMs: 30_000,
  hardLimitMs: 60_000,
})

export type OpenShopToolTimeouts = { [Key in keyof typeof OPENSHOP_TOOL_TIMEOUTS]: number }

export interface OpenShopToolRunnerOptions {
  sourceTaskId: string | null
  inputAssetId: string
  commands: readonly OpenShopCanvasCommand[]
  outputFormat: 'png'
  signal?: AbortSignal
  frameUrl?: string
  timeouts?: Partial<OpenShopToolTimeouts>
  /** false 时仅执行、导出和校验，不进入最终 Task 保存。 */
  saveOutput?: boolean
}

export interface OpenShopToolExportResult {
  blob: Blob
  filename: string
  document: OpenShopToolDocumentDescriptor
}

export interface OpenShopToolRunnerResult extends OpenShopToolExportResult {
  task: TaskRecord
}

export class OpenShopToolRunnerError extends Error {
  readonly code: OpenShopToolErrorCode
  readonly retryable: boolean
  readonly commandIndex?: number

  constructor(
    code: OpenShopToolErrorCode,
    message: string,
    options: { retryable?: boolean; commandIndex?: number; cause?: unknown } = {},
  ) {
    super(message)
    if (options.cause !== undefined) (this as Error & { cause?: unknown }).cause = options.cause
    this.name = 'OpenShopToolRunnerError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.commandIndex = options.commandIndex
  }
}

interface PendingToolRequest {
  expectedType: OpenShopToolResponseMessage['type']
  resolve: (message: OpenShopToolResponseMessage) => void
  reject: (error: OpenShopToolRunnerError) => void
  cleanup: () => void
}

type MessageHost = Pick<Window, 'addEventListener' | 'removeEventListener'>

const TOOL_ERROR_CODES = new Set<OpenShopToolErrorCode>([
  'INVALID_REQUEST',
  'UNSUPPORTED_COMMAND',
  'VALIDATION_FAILED',
  'REVISION_CONFLICT',
  'BUSY',
  'CANCELLED',
  'TIMEOUT',
  'IMPORT_FAILED',
  'EXECUTION_FAILED',
  'EXPORT_FAILED',
  'SESSION_EXPIRED',
])

function toRunnerError(message: OpenShopToolErrorMessage): OpenShopToolRunnerError {
  const code = TOOL_ERROR_CODES.has(message.code) ? message.code : 'INVALID_REQUEST'
  return new OpenShopToolRunnerError(code, message.message, {
    retryable: message.retryable,
    commandIndex: message.commandIndex,
  })
}

/** 单 iframe 的严格 request/response 路由器。 */
export class OpenShopToolBridgeClient {
  private readonly pending = new Map<string, PendingToolRequest>()
  private disposed = false

  constructor(
    private readonly host: MessageHost,
    private readonly frameWindow: Window,
    private readonly targetOrigin: string,
    private readonly sessionId: string,
  ) {
    this.host.addEventListener('message', this.onMessage as EventListener)
  }

  private readonly onMessage = (event: MessageEvent) => {
    if (event.source !== this.frameWindow || event.origin !== this.targetOrigin) return
    const candidate = event.data as Record<string, unknown> | null
    const id = candidate && typeof candidate === 'object' && typeof candidate.id === 'string'
      ? candidate.id
      : null
    const request = id ? this.pending.get(id) : undefined
    if (!request) return
    if (!isOpenShopToolResponseMessage(event.data)) {
      request.cleanup()
      request.reject(new OpenShopToolRunnerError('INVALID_REQUEST', 'OpenShop 返回了不符合 schema 的响应'))
      return
    }
    if (event.data.sessionId !== this.sessionId) {
      request.cleanup()
      request.reject(new OpenShopToolRunnerError('INVALID_REQUEST', 'OpenShop 响应 sessionId 不匹配'))
      return
    }

    if (event.data.type === 'openshop:tool:error') {
      request.cleanup()
      request.reject(toRunnerError(event.data))
      return
    }
    if (event.data.type !== request.expectedType) {
      request.cleanup()
      request.reject(new OpenShopToolRunnerError(
        'INVALID_REQUEST',
        `OpenShop 响应类型错误：期望 ${request.expectedType}，实际为 ${event.data.type}`,
      ))
      return
    }

    request.cleanup()
    request.resolve(event.data)
  }

  request<T extends OpenShopToolResponseMessage>(
    type: OpenShopToolRequestMessage['type'],
    expectedType: T['type'],
    payload: Record<string, unknown>,
    { timeoutMs, signal, retryMs }: { timeoutMs: number; signal?: AbortSignal; retryMs?: number },
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new OpenShopToolRunnerError('CANCELLED', 'OpenShop iframe 已销毁'))
    }
    if (signal?.aborted) {
      return Promise.reject(readAbortReason(signal))
    }

    const id = createOpenShopRequestId(type.replace(/^openshop:tool:/, 'tool'))
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let retryTimer: ReturnType<typeof globalThis.setInterval> | null = null
      const finish = () => {
        if (settled) return false
        settled = true
        clearTimeout(timer)
        if (retryTimer != null) clearInterval(retryTimer)
        signal?.removeEventListener('abort', onAbort)
        this.pending.delete(id)
        return true
      }
      const onAbort = () => {
        if (!finish()) return
        reject(readAbortReason(signal))
      }
      const timer = globalThis.setTimeout(() => {
        if (!finish()) return
        reject(new OpenShopToolRunnerError('TIMEOUT', `OpenShop 阶段超时：${type}`, { retryable: true }))
      }, timeoutMs)

      this.pending.set(id, {
        expectedType,
        cleanup: finish,
        resolve: (message) => resolve(message as T),
        reject,
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      const outbound = {
        type,
        id,
        requestId: id,
        sessionId: this.sessionId,
        ...payload,
      } as Omit<OpenShopToolRequestMessage, 'version'>
      const send = () => {
        if (settled) return
        try {
          postOpenShopToolMessage(this.frameWindow, this.targetOrigin, outbound)
        } catch (cause) {
          if (!finish()) return
          reject(new OpenShopToolRunnerError('INVALID_REQUEST', '无法向 OpenShop iframe 发送请求', { cause }))
        }
      }
      if (retryMs && retryMs > 0) retryTimer = globalThis.setInterval(send, retryMs)
      send()
    })
  }

  dispose(reason = new OpenShopToolRunnerError('CANCELLED', 'OpenShop iframe 已销毁')) {
    if (this.disposed) return
    this.disposed = true
    this.host.removeEventListener('message', this.onMessage as EventListener)
    for (const request of [...this.pending.values()]) {
      request.cleanup()
      request.reject(reason)
    }
    this.pending.clear()
  }
}

export interface OpenShopToolSaveContext {
  signal: AbortSignal
  timeoutMs: number
  onCommit: () => void
}

export interface OpenShopToolRunnerDependencies {
  hostWindow: Window
  hostDocument: Document
  loadInput: (sourceTaskId: string | null, inputAssetId: string, signal: AbortSignal) => Promise<OpenShopDocument>
  saveOutput: (
    sourceTaskId: string | null,
    inputAssetId: string,
    blob: Blob,
    context: OpenShopToolSaveContext,
  ) => Promise<TaskRecord>
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

function readAbortReason(signal?: AbortSignal): OpenShopToolRunnerError {
  if (signal?.reason instanceof OpenShopToolRunnerError) return signal.reason
  return new OpenShopToolRunnerError('CANCELLED', 'OpenShop 编辑已取消')
}

class OpenShopRunnerDeadline {
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly deadlineAt: number
  private readonly hardTimer: ReturnType<typeof globalThis.setTimeout>
  private readonly onExternalAbort: (() => void) | null

  constructor(hardLimitMs: number, private readonly externalSignal?: AbortSignal) {
    const normalizedHardLimit = Math.max(0, hardLimitMs)
    this.deadlineAt = Date.now() + normalizedHardLimit
    this.signal = this.controller.signal
    this.onExternalAbort = externalSignal
      ? () => this.abort(new OpenShopToolRunnerError('CANCELLED', 'OpenShop 编辑已取消'))
      : null
    if (this.onExternalAbort) externalSignal?.addEventListener('abort', this.onExternalAbort, { once: true })
    if (externalSignal?.aborted) this.onExternalAbort?.()
    this.hardTimer = globalThis.setTimeout(() => {
      this.abort(new OpenShopToolRunnerError('TIMEOUT', 'OpenShop 编辑超过 60 秒硬上限', { retryable: true }))
    }, normalizedHardLimit)
  }

  private abort(reason: OpenShopToolRunnerError) {
    if (!this.signal.aborted) this.controller.abort(reason)
  }

  throwIfAborted() {
    if (this.signal.aborted) throw readAbortReason(this.signal)
    if (Date.now() >= this.deadlineAt) {
      const error = new OpenShopToolRunnerError('TIMEOUT', 'OpenShop 编辑超过 60 秒硬上限', { retryable: true })
      this.abort(error)
      throw error
    }
  }

  remaining(stageLimitMs?: number) {
    this.throwIfAborted()
    const remaining = this.deadlineAt - Date.now()
    const bounded = stageLimitMs === undefined ? remaining : Math.min(remaining, Math.max(0, stageLimitMs))
    if (bounded <= 0) {
      const error = new OpenShopToolRunnerError('TIMEOUT', 'OpenShop 编辑超过 60 秒硬上限', { retryable: true })
      this.abort(error)
      throw error
    }
    return Math.max(1, bounded)
  }

  wait<T>(
    operation: () => Promise<T> | T,
    options: {
      stageLimitMs?: number
      timeoutMessage?: string
      ignoreAbort?: () => boolean
    } = {},
  ): Promise<T> {
    let timeoutMs: number
    try {
      timeoutMs = this.remaining(options.stageLimitMs)
    } catch (error) {
      return Promise.reject(error)
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let abortIgnored = false
      const cleanup = () => {
        clearTimeout(stageTimer)
        this.signal.removeEventListener('abort', onAbort)
      }
      const finish = () => {
        if (settled) return false
        settled = true
        cleanup()
        return true
      }
      const onAbort = () => {
        if (options.ignoreAbort?.()) {
          abortIgnored = true
          cleanup()
          return
        }
        if (finish()) reject(readAbortReason(this.signal))
      }
      const stageTimer = globalThis.setTimeout(() => {
        const error = new OpenShopToolRunnerError(
          'TIMEOUT',
          options.timeoutMessage ?? 'OpenShop 编辑超过 60 秒硬上限',
          { retryable: true },
        )
        this.abort(error)
      }, timeoutMs)
      this.signal.addEventListener('abort', onAbort, { once: true })
      if (this.signal.aborted) {
        onAbort()
        if (settled) return
      }
      Promise.resolve()
        .then(operation)
        .then(
          (value) => {
            if (abortIgnored || finish()) resolve(value)
          },
          (error) => {
            if (abortIgnored || finish()) reject(error)
          },
        )
    })
  }

  dispose() {
    clearTimeout(this.hardTimer)
    if (this.onExternalAbort) this.externalSignal?.removeEventListener('abort', this.onExternalAbort)
  }
}

async function decodeImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    try {
      return { width: bitmap.width, height: bitmap.height }
    } finally {
      bitmap.close()
    }
  }

  const objectUrl = URL.createObjectURL(blob)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('图片解码失败'))
      image.src = objectUrl
    })
    return { width: image.naturalWidth, height: image.naturalHeight }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

async function validateInputImage(input: OpenShopDocument, deadline: OpenShopRunnerDeadline) {
  const mimeType = input.blob.type.toLowerCase()
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
    throw new OpenShopToolRunnerError('IMPORT_FAILED', `OpenShop 不支持输入格式 ${mimeType || 'unknown'}`)
  }
  const magicMatches = await deadline.wait(() => blobHasExpectedImageMagic(input.blob), {
    timeoutMessage: 'OpenShop 输入图片校验超时',
  })
  if (!magicMatches) {
    throw new OpenShopToolRunnerError('IMPORT_FAILED', 'OpenShop 输入图片 MIME 与 magic bytes 不一致')
  }
  let dimensions: { width: number; height: number }
  try {
    dimensions = await deadline.wait(() => decodeImageDimensions(input.blob), {
      timeoutMessage: 'OpenShop 输入图片解码超时',
    })
  } catch (cause) {
    if (cause instanceof OpenShopToolRunnerError) throw cause
    throw new OpenShopToolRunnerError('IMPORT_FAILED', 'OpenShop 输入图片无法解码', { cause })
  }
  if (!Number.isSafeInteger(dimensions.width)
    || !Number.isSafeInteger(dimensions.height)
    || dimensions.width < 1
    || dimensions.height < 1
    || dimensions.width * dimensions.height > OPENSHOP_TOOL_MAX_IMAGE_PIXELS) {
    throw new OpenShopToolRunnerError('IMPORT_FAILED', 'OpenShop 输入图片尺寸无效或超过 8000 万像素上限')
  }
  return dimensions
}

async function validateExportedPng(
  blob: Blob,
  expected: OpenShopToolDocumentDescriptor,
  deadline: OpenShopRunnerDeadline,
) {
  const signature = await deadline.wait(
    async () => new Uint8Array(await blob.slice(0, PNG_SIGNATURE.length).arrayBuffer()),
    { timeoutMessage: 'OpenShop 输出 PNG 校验超时' },
  )
  if (signature.length !== PNG_SIGNATURE.length
    || PNG_SIGNATURE.some((byte, index) => signature[index] !== byte)) {
    throw new OpenShopToolRunnerError('EXPORT_FAILED', 'OpenShop 输出缺少有效 PNG signature')
  }
  let dimensions: { width: number; height: number }
  try {
    dimensions = await deadline.wait(() => decodeImageDimensions(blob), {
      timeoutMessage: 'OpenShop 输出 PNG 解码超时',
    })
  } catch (cause) {
    if (cause instanceof OpenShopToolRunnerError) throw cause
    throw new OpenShopToolRunnerError('EXPORT_FAILED', 'OpenShop 输出 PNG 无法解码', { cause })
  }
  if (dimensions.width !== expected.canvas.width || dimensions.height !== expected.canvas.height) {
    throw new OpenShopToolRunnerError('EXPORT_FAILED', 'OpenShop 输出 PNG 解码尺寸与执行结果不一致')
  }
}

function createDefaultDependencies(): OpenShopToolRunnerDependencies {
  return {
    hostWindow: window,
    hostDocument: document,
    loadInput: async (sourceTaskId, inputAssetId) => {
      if (sourceTaskId) {
        const sourceTask = useStore.getState().tasks.find((task) => task.id === sourceTaskId)
        if (!sourceTask) throw new OpenShopToolRunnerError('IMPORT_FAILED', 'OpenShop 输入来源任务不存在')
        if (!sourceTask.outputImages.includes(inputAssetId)) {
          throw new OpenShopToolRunnerError('IMPORT_FAILED', 'OpenShop 输入资源不属于来源任务')
        }
      }
      const dataUrl = await ensureImageCached(inputAssetId)
      if (!dataUrl) throw new OpenShopToolRunnerError('IMPORT_FAILED', 'OpenShop 输入资源不存在')
      return dataUrlToOpenShopDocument(dataUrl, `source-${inputAssetId.slice(0, 12)}.png`)
    },
    saveOutput: (sourceTaskId, inputAssetId, blob, context) => saveOpenShopEdit({
      sourceTaskId,
      inputImageIds: [inputAssetId],
      outputImage: blob,
      signal: context.signal,
      timeoutMs: context.timeoutMs,
      onCommit: context.onCommit,
    }),
  }
}

function createHiddenFrame(hostDocument: Document, frameUrl: string) {
  const frame = hostDocument.createElement('iframe')
  frame.src = frameUrl
  frame.title = 'OpenShop Tool Runner'
  frame.tabIndex = -1
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('data-openshop-tool-frame', '')
  frame.style.position = 'fixed'
  frame.style.left = '-10000px'
  frame.style.top = '0'
  frame.style.width = '1280px'
  frame.style.height = '900px'
  frame.style.opacity = '0'
  frame.style.pointerEvents = 'none'
  frame.style.border = '0'
  return frame
}

function appendAndWaitForFrameLoad(
  frame: HTMLIFrameElement,
  hostDocument: Document,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = () => {
      if (settled) return false
      settled = true
      frame.removeEventListener('load', onLoad)
      frame.removeEventListener('error', onError)
      signal.removeEventListener('abort', onAbort)
      return true
    }
    const onLoad = () => {
      if (finish()) resolve()
    }
    const onError = () => {
      if (finish()) reject(new OpenShopToolRunnerError('IMPORT_FAILED', 'OpenShop iframe 加载失败', { retryable: true }))
    }
    const onAbort = () => {
      if (finish()) reject(readAbortReason(signal))
    }
    frame.addEventListener('load', onLoad, { once: true })
    frame.addEventListener('error', onError, { once: true })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    try {
      hostDocument.body.appendChild(frame)
    } catch (cause) {
      if (finish()) {
        reject(new OpenShopToolRunnerError('IMPORT_FAILED', '无法挂载 OpenShop iframe', { cause }))
      }
    }
  })
}

function assertDescriptor(value: OpenShopToolDocumentDescriptor, stage: string) {
  if (value.canvas.width * value.canvas.height > OPENSHOP_TOOL_MAX_IMAGE_PIXELS) {
    throw new OpenShopToolRunnerError('INVALID_REQUEST', `OpenShop ${stage} 画布超过 8000 万像素上限`)
  }
  if (value.primaryImage.present !== true) {
    throw new OpenShopToolRunnerError('INVALID_REQUEST', `OpenShop ${stage} 未返回有效主图摘要`)
  }
}

function assertReady(message: Extract<OpenShopToolResponseMessage, { type: 'openshop:tool:ready' }>, inputMimeType: string) {
  const capabilities = message.capabilities
  if (!OPENSHOP_TOOL_COMMAND_IDS.every((command) => capabilities.commands.includes(command))
    || capabilities.maxCommands < OPENSHOP_TOOL_MAX_COMMANDS
    || !capabilities.inputMimeTypes.includes(inputMimeType)
    || !capabilities.outputFormats.includes('png')) {
    throw new OpenShopToolRunnerError('INVALID_REQUEST', 'OpenShop Tool 能力协商失败')
  }
}

function mapUnexpectedRunnerError(cause: unknown): OpenShopToolRunnerError {
  if (cause instanceof OpenShopToolRunnerError) return cause
  if (cause instanceof DOMException && cause.name === 'AbortError') {
    return new OpenShopToolRunnerError('CANCELLED', 'OpenShop 编辑已取消', { cause })
  }
  if (cause instanceof DOMException && cause.name === 'TimeoutError') {
    return new OpenShopToolRunnerError('TIMEOUT', 'OpenShop 编辑超过 60 秒硬上限', { retryable: true, cause })
  }
  return new OpenShopToolRunnerError(
    'EXECUTION_FAILED',
    cause instanceof Error ? cause.message : String(cause),
    { cause },
  )
}

export function openShopToolRunner(
  options: OpenShopToolRunnerOptions & { saveOutput: false },
  dependencies?: OpenShopToolRunnerDependencies,
): Promise<OpenShopToolExportResult>
export function openShopToolRunner(
  options: OpenShopToolRunnerOptions,
  dependencies?: OpenShopToolRunnerDependencies,
): Promise<OpenShopToolRunnerResult>
export async function openShopToolRunner(
  options: OpenShopToolRunnerOptions,
  dependencies: OpenShopToolRunnerDependencies = createDefaultDependencies(),
): Promise<OpenShopToolRunnerResult | OpenShopToolExportResult> {
  const timeouts = { ...OPENSHOP_TOOL_TIMEOUTS, ...options.timeouts }
  const deadline = new OpenShopRunnerDeadline(timeouts.hardLimitMs, options.signal)
  let frame: HTMLIFrameElement | null = null
  let client: OpenShopToolBridgeClient | null = null
  try {
    if (options.outputFormat !== 'png') {
      throw new OpenShopToolRunnerError('INVALID_REQUEST', 'OpenShop MVP 仅支持 PNG 输出')
    }
    let commands: OpenShopCanvasCommand[]
    try {
      commands = normalizeOpenShopToolCommands(options.commands)
    } catch (cause) {
      throw new OpenShopToolRunnerError('INVALID_REQUEST', cause instanceof Error ? cause.message : String(cause), { cause })
    }
    deadline.throwIfAborted()

    let input: OpenShopDocument
    try {
      input = await deadline.wait(
        () => dependencies.loadInput(options.sourceTaskId, options.inputAssetId, deadline.signal),
        { timeoutMessage: 'OpenShop 输入加载超时' },
      )
    } catch (cause) {
      if (cause instanceof OpenShopToolRunnerError) throw cause
      if (cause instanceof DOMException) throw mapUnexpectedRunnerError(cause)
      throw new OpenShopToolRunnerError('IMPORT_FAILED', cause instanceof Error ? cause.message : String(cause), { cause })
    }
    await validateInputImage(input, deadline)

    const frameUrl = options.frameUrl ?? getOpenShopFrameUrl(dependencies.hostWindow.location.href)
    const targetOrigin = getOpenShopTargetOrigin(frameUrl)
    if (targetOrigin !== dependencies.hostWindow.location.origin) {
      throw new OpenShopToolRunnerError('INVALID_REQUEST', 'OpenShop Tool 只允许同源 iframe')
    }

    frame = createHiddenFrame(dependencies.hostDocument, frameUrl)
    const handshakeStartedAt = Date.now()
    await deadline.wait(
      () => appendAndWaitForFrameLoad(frame as HTMLIFrameElement, dependencies.hostDocument, deadline.signal),
      { stageLimitMs: timeouts.handshakeMs, timeoutMessage: 'OpenShop 握手超时' },
    )

    const frameWindow = frame.contentWindow
    if (!frameWindow) throw new OpenShopToolRunnerError('IMPORT_FAILED', 'OpenShop iframe 无可用窗口')
    const sessionId = createOpenShopRequestId('openshop-tool-session')
    client = new OpenShopToolBridgeClient(dependencies.hostWindow, frameWindow, targetOrigin, sessionId)

    const handshakeRemaining = timeouts.handshakeMs - (Date.now() - handshakeStartedAt)
    if (handshakeRemaining <= 0) {
      throw new OpenShopToolRunnerError('TIMEOUT', 'OpenShop 握手超时', { retryable: true })
    }

    const ready = await deadline.wait(
      () => client?.request<Extract<OpenShopToolResponseMessage, { type: 'openshop:tool:ready' }>>(
        'openshop:tool:hello',
        'openshop:tool:ready',
        {},
        {
          timeoutMs: deadline.remaining(handshakeRemaining),
          signal: deadline.signal,
          retryMs: 250,
        },
      ) as Promise<Extract<OpenShopToolResponseMessage, { type: 'openshop:tool:ready' }>>,
      { stageLimitMs: handshakeRemaining, timeoutMessage: 'OpenShop 握手超时' },
    )
    assertReady(ready, input.blob.type.toLowerCase())

    const configured = await deadline.wait(
      () => client?.request<Extract<OpenShopToolResponseMessage, { type: 'openshop:tool:configured' }>>(
        'openshop:tool:configure',
        'openshop:tool:configured',
        { document: input },
        {
          timeoutMs: deadline.remaining(timeouts.configureMs),
          signal: deadline.signal,
        },
      ) as Promise<Extract<OpenShopToolResponseMessage, { type: 'openshop:tool:configured' }>>,
      { stageLimitMs: timeouts.configureMs, timeoutMessage: 'OpenShop 配置超时' },
    )
    assertDescriptor(configured.document, '导入阶段')

    const executed = await deadline.wait(
      () => client?.request<Extract<OpenShopToolResponseMessage, { type: 'openshop:tool:executed' }>>(
        'openshop:tool:execute',
        'openshop:tool:executed',
        { commands },
        {
          timeoutMs: deadline.remaining(timeouts.executeMs),
          signal: deadline.signal,
        },
      ) as Promise<Extract<OpenShopToolResponseMessage, { type: 'openshop:tool:executed' }>>,
      { stageLimitMs: timeouts.executeMs, timeoutMessage: 'OpenShop 命令执行超时' },
    )
    if (executed.appliedCommands !== commands.length) {
      throw new OpenShopToolRunnerError('INVALID_REQUEST', 'OpenShop 未确认完整执行命令批次')
    }
    assertDescriptor(executed.document, '执行阶段')

    const exported = await deadline.wait(
      () => client?.request<OpenShopToolExportedMessage>(
        'openshop:tool:export',
        'openshop:tool:exported',
        { format: 'png' },
        {
          timeoutMs: deadline.remaining(timeouts.exportMs),
          signal: deadline.signal,
        },
      ) as Promise<OpenShopToolExportedMessage>,
      { stageLimitMs: timeouts.exportMs, timeoutMessage: 'OpenShop 导出超时' },
    )
    if (exported.blob.type !== 'image/png' || exported.blob.size < 1 || exported.format !== 'png') {
      throw new OpenShopToolRunnerError('EXPORT_FAILED', 'OpenShop 未返回有效 PNG')
    }
    assertDescriptor(exported.document, '导出阶段')
    if (exported.document.canvas.width !== executed.document.canvas.width
      || exported.document.canvas.height !== executed.document.canvas.height) {
      throw new OpenShopToolRunnerError('EXPORT_FAILED', 'OpenShop 导出尺寸与执行结果不一致')
    }
    await validateExportedPng(exported.blob, exported.document, deadline)

    const exportResult: OpenShopToolExportResult = {
      blob: exported.blob,
      filename: exported.filename,
      document: exported.document,
    }
    if (options.saveOutput === false) return exportResult

    let committed = false
    const task = await deadline.wait(
      () => dependencies.saveOutput(options.sourceTaskId, options.inputAssetId, exported.blob, {
        signal: deadline.signal,
        timeoutMs: deadline.remaining(),
        onCommit: () => { committed = true },
      }),
      {
        timeoutMessage: 'OpenShop 输出保存超时',
        ignoreAbort: () => committed,
      },
    )
    return {
      ...exportResult,
      task,
    }
  } catch (cause) {
    throw mapUnexpectedRunnerError(cause)
  } finally {
    client?.dispose()
    frame?.remove()
    deadline.dispose()
  }
}

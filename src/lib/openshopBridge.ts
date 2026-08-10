export const OPENSHOP_PROTOCOL_VERSION = 1
export const OPENSHOP_TOOL_PROTOCOL_VERSION = 1
export const OPENSHOP_TOOL_MAX_COMMANDS = 5
export const OPENSHOP_TOOL_MAX_IMAGE_PIXELS = 80_000_000

export const OPENSHOP_TOOL_COMMAND_IDS = [
  'canvas.crop',
  'canvas.rotate',
  'canvas.flip',
  'canvas.flatten',
] as const

export type OpenShopToolCommandId = typeof OPENSHOP_TOOL_COMMAND_IDS[number]
export type OpenShopToolErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_COMMAND'
  | 'VALIDATION_FAILED'
  | 'REVISION_CONFLICT'
  | 'BUSY'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'IMPORT_FAILED'
  | 'EXECUTION_FAILED'
  | 'EXPORT_FAILED'
  | 'SESSION_EXPIRED'

export interface OpenShopToolCropCommand {
  schemaVersion: 1
  id: 'canvas.crop'
  target: 'document'
  args: { x: number; y: number; width: number; height: number }
}

export interface OpenShopToolRotateCommand {
  schemaVersion: 1
  id: 'canvas.rotate'
  target: 'document'
  args: { degrees: 90 | -90 | 180 | -180 }
}

export interface OpenShopToolFlipCommand {
  schemaVersion: 1
  id: 'canvas.flip'
  target: 'document'
  args: { axis: 'h' | 'v' }
}

export interface OpenShopToolFlattenCommand {
  schemaVersion: 1
  id: 'canvas.flatten'
  target: 'document'
  args: Record<never, never>
}

export type OpenShopCanvasCommand =
  | OpenShopToolCropCommand
  | OpenShopToolRotateCommand
  | OpenShopToolFlipCommand
  | OpenShopToolFlattenCommand

export interface OpenShopToolDocumentDescriptor {
  canvas: { width: number; height: number }
  primaryImage: {
    present: boolean
    bounds?: { x: number; y: number; width: number; height: number }
  }
}

export type OpenShopExportFormat = 'png'

export interface OpenShopDocument {
  blob: Blob
  name: string
}

export interface OpenShopMessage {
  version: number
  type: string
  id?: string | null
  [key: string]: unknown
}

interface OpenShopToolMessageBase extends OpenShopMessage {
  type: `openshop:tool:${string}`
  id: string
  requestId: string
  sessionId: string
}

export interface OpenShopToolHelloMessage extends OpenShopToolMessageBase {
  type: 'openshop:tool:hello'
}

export interface OpenShopToolConfigureMessage extends OpenShopToolMessageBase {
  type: 'openshop:tool:configure'
  document: OpenShopDocument
}

export interface OpenShopToolExecuteMessage extends OpenShopToolMessageBase {
  type: 'openshop:tool:execute'
  commands: OpenShopCanvasCommand[]
}

export interface OpenShopToolExportMessage extends OpenShopToolMessageBase {
  type: 'openshop:tool:export'
  format: 'png'
}

export interface OpenShopToolReadyMessage extends OpenShopToolMessageBase {
  type: 'openshop:tool:ready'
  capabilities: {
    commands: string[]
    maxCommands: number
    inputMimeTypes: string[]
    outputFormats: string[]
  }
}

export interface OpenShopToolConfiguredMessage extends OpenShopToolMessageBase {
  type: 'openshop:tool:configured'
  document: OpenShopToolDocumentDescriptor
}

export interface OpenShopToolExecutedMessage extends OpenShopToolMessageBase {
  type: 'openshop:tool:executed'
  appliedCommands: number
  changed: boolean
  document: OpenShopToolDocumentDescriptor
}

export interface OpenShopToolErrorMessage extends OpenShopToolMessageBase {
  type: 'openshop:tool:error'
  code: OpenShopToolErrorCode
  message: string
  retryable: boolean
  commandIndex?: number
}

export interface OpenShopToolExportedMessage extends OpenShopToolMessageBase {
  type: 'openshop:tool:exported'
  blob: Blob
  filename: string
  format: 'png'
  document: OpenShopToolDocumentDescriptor
}

export type OpenShopToolRequestMessage =
  | OpenShopToolHelloMessage
  | OpenShopToolConfigureMessage
  | OpenShopToolExecuteMessage
  | OpenShopToolExportMessage

export type OpenShopToolResponseMessage =
  | OpenShopToolReadyMessage
  | OpenShopToolConfiguredMessage
  | OpenShopToolExecutedMessage
  | OpenShopToolExportedMessage
  | OpenShopToolErrorMessage

export type OpenShopToolMessage = OpenShopToolRequestMessage | OpenShopToolResponseMessage

export interface OpenShopExportedMessage extends OpenShopMessage {
  type: 'openshop:exported'
  blob: Blob
  filename: string
  format: OpenShopExportFormat
}

export interface OpenShopSaveRequestedMessage extends OpenShopMessage {
  type: 'openshop:save-requested'
  blob: Blob
  filename: string
}

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

const TOOL_MESSAGE_BASE_KEYS = ['version', 'type', 'id', 'requestId', 'sessionId'] as const

export function getOpenShopFrameUrl(pageUrl = window.location.href): string {
  return new URL('openshop/index.html', pageUrl).toString()
}

export function getOpenShopTargetOrigin(frameUrl: string): string {
  return new URL(frameUrl).origin
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isOpenShopDocument(value: unknown): value is OpenShopDocument {
  return isPlainRecord(value)
    && hasExactKeys(value, ['blob', 'name'])
    && value.blob instanceof Blob
    && isNonEmptyString(value.name)
}

function isOpenShopToolDocumentDescriptor(value: unknown): value is OpenShopToolDocumentDescriptor {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['canvas', 'primaryImage'])) return false
  const { canvas, primaryImage } = value
  if (!isPlainRecord(canvas)
    || !hasExactKeys(canvas, ['width', 'height'])
    || !isSafePositiveInteger(canvas.width)
    || !isSafePositiveInteger(canvas.height)
    || !isPlainRecord(primaryImage)
    || !hasExactKeys(primaryImage, ['present'], ['bounds'])
    || typeof primaryImage.present !== 'boolean') return false
  if (primaryImage.bounds === undefined) return true
  const bounds = primaryImage.bounds
  return isPlainRecord(bounds)
    && hasExactKeys(bounds, ['x', 'y', 'width', 'height'])
    && isFiniteNumber(bounds.x)
    && isFiniteNumber(bounds.y)
    && isFiniteNumber(bounds.width)
    && isFiniteNumber(bounds.height)
}

function hasValidToolEnvelope(value: Record<string, unknown>) {
  return value.version === OPENSHOP_TOOL_PROTOCOL_VERSION
    && isNonEmptyString(value.type)
    && value.type.startsWith('openshop:tool:')
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.requestId)
    && value.requestId === value.id
    && isNonEmptyString(value.sessionId)
}

export function isOpenShopMessage(value: unknown): value is OpenShopMessage {
  if (!isPlainRecord(value)) return false
  return typeof value.type === 'string'
    && value.type.startsWith('openshop:')
    && typeof value.version === 'number'
    && value.version === OPENSHOP_PROTOCOL_VERSION
}

export function isOpenShopToolRequestMessage(value: unknown): value is OpenShopToolRequestMessage {
  if (!isPlainRecord(value) || !hasValidToolEnvelope(value)) return false
  switch (value.type) {
    case 'openshop:tool:hello':
      return hasExactKeys(value, TOOL_MESSAGE_BASE_KEYS)
    case 'openshop:tool:configure':
      return hasExactKeys(value, [...TOOL_MESSAGE_BASE_KEYS, 'document'])
        && isOpenShopDocument(value.document)
    case 'openshop:tool:execute':
      if (!hasExactKeys(value, [...TOOL_MESSAGE_BASE_KEYS, 'commands'])) return false
      try {
        normalizeOpenShopToolCommands(value.commands)
        return true
      } catch {
        return false
      }
    case 'openshop:tool:export':
      return hasExactKeys(value, [...TOOL_MESSAGE_BASE_KEYS, 'format']) && value.format === 'png'
    default:
      return false
  }
}

export function isOpenShopToolResponseMessage(value: unknown): value is OpenShopToolResponseMessage {
  if (!isPlainRecord(value) || !hasValidToolEnvelope(value)) return false
  switch (value.type) {
    case 'openshop:tool:ready': {
      if (!hasExactKeys(value, [...TOOL_MESSAGE_BASE_KEYS, 'capabilities']) || !isPlainRecord(value.capabilities)) return false
      const capabilities = value.capabilities
      return hasExactKeys(capabilities, ['commands', 'maxCommands', 'inputMimeTypes', 'outputFormats'])
        && isStringArray(capabilities.commands)
        && typeof capabilities.maxCommands === 'number'
        && Number.isSafeInteger(capabilities.maxCommands)
        && capabilities.maxCommands > 0
        && isStringArray(capabilities.inputMimeTypes)
        && isStringArray(capabilities.outputFormats)
    }
    case 'openshop:tool:configured':
      return hasExactKeys(value, [...TOOL_MESSAGE_BASE_KEYS, 'document'])
        && isOpenShopToolDocumentDescriptor(value.document)
    case 'openshop:tool:executed':
      return hasExactKeys(value, [...TOOL_MESSAGE_BASE_KEYS, 'appliedCommands', 'changed', 'document'])
        && typeof value.appliedCommands === 'number'
        && Number.isSafeInteger(value.appliedCommands)
        && value.appliedCommands >= 0
        && typeof value.changed === 'boolean'
        && isOpenShopToolDocumentDescriptor(value.document)
    case 'openshop:tool:exported':
      return hasExactKeys(value, [...TOOL_MESSAGE_BASE_KEYS, 'blob', 'filename', 'format', 'document'])
        && value.blob instanceof Blob
        && isNonEmptyString(value.filename)
        && value.format === 'png'
        && isOpenShopToolDocumentDescriptor(value.document)
    case 'openshop:tool:error':
      return hasExactKeys(value, [...TOOL_MESSAGE_BASE_KEYS, 'code', 'message', 'retryable'], ['commandIndex'])
        && TOOL_ERROR_CODES.has(value.code as OpenShopToolErrorCode)
        && isNonEmptyString(value.message)
        && typeof value.retryable === 'boolean'
        && (value.commandIndex === undefined
          || (typeof value.commandIndex === 'number' && Number.isSafeInteger(value.commandIndex) && value.commandIndex >= 0))
    default:
      return false
  }
}

export function isOpenShopToolMessage(value: unknown): value is OpenShopToolMessage {
  return isOpenShopToolRequestMessage(value) || isOpenShopToolResponseMessage(value)
}

export function isOpenShopMessageFromFrame(
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  frameWindow: Window | null,
  targetOrigin: string,
): event is Pick<MessageEvent, 'origin' | 'source'> & { data: OpenShopMessage } {
  return event.source === frameWindow
    && event.origin === targetOrigin
    && isOpenShopMessage(event.data)
}

export function isOpenShopToolMessageFromFrame(
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  frameWindow: Window | null,
  targetOrigin: string,
): event is Pick<MessageEvent, 'origin' | 'source'> & { data: OpenShopToolResponseMessage } {
  return event.source === frameWindow
    && event.origin === targetOrigin
    && isOpenShopToolResponseMessage(event.data)
}

/** 回复必须关联到一个仍在等待的、非空请求 ID。 */
export function isOpenShopRequestIdMatch(expectedId: string | null | undefined, responseId: unknown): boolean {
  return typeof expectedId === 'string' && expectedId.length > 0 && responseId === expectedId
}

export function createOpenShopRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function postOpenShopMessage(
  frameWindow: Window,
  targetOrigin: string,
  message: Omit<OpenShopMessage, 'version'>,
) {
  frameWindow.postMessage({ version: OPENSHOP_PROTOCOL_VERSION, ...message }, targetOrigin)
}

export function postOpenShopToolMessage(
  frameWindow: Window,
  targetOrigin: string,
  message: Omit<OpenShopToolRequestMessage, 'version'>,
) {
  const outbound = { version: OPENSHOP_TOOL_PROTOCOL_VERSION, ...message }
  if (!isOpenShopToolRequestMessage(outbound)) throw new Error('OpenShop Tool 请求 schema 无效')
  frameWindow.postMessage(outbound, targetOrigin)
}

function readInteger(value: unknown, name: string, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`)
  }
  return value
}

/** 在消息跨 iframe 前固定 MVP command 形状。 */
export function normalizeOpenShopToolCommands(value: unknown): OpenShopCanvasCommand[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > OPENSHOP_TOOL_MAX_COMMANDS) {
    throw new Error(`OpenShop 每次只能执行 1 到 ${OPENSHOP_TOOL_MAX_COMMANDS} 条命令`)
  }

  return value.map((candidate, commandIndex) => {
    if (!isPlainRecord(candidate)
      || !hasExactKeys(candidate, ['schemaVersion', 'id', 'target', 'args'])
      || typeof candidate.schemaVersion !== 'number'
      || candidate.schemaVersion !== 1
      || candidate.target !== 'document'
      || typeof candidate.id !== 'string'
      || !isPlainRecord(candidate.args)) {
      throw new Error(`第 ${commandIndex + 1} 条 OpenShop 命令格式无效`)
    }

    const args = candidate.args
    switch (candidate.id) {
      case 'canvas.crop': {
        if (!hasExactKeys(args, ['x', 'y', 'width', 'height'])) {
          throw new Error(`第 ${commandIndex + 1} 条裁剪命令参数无效`)
        }
        const width = readInteger(args.width, '裁剪宽度', 1, 30_000)
        const height = readInteger(args.height, '裁剪高度', 1, 30_000)
        if (width * height > OPENSHOP_TOOL_MAX_IMAGE_PIXELS) {
          throw new Error(`第 ${commandIndex + 1} 条裁剪命令超过 8000 万像素上限`)
        }
        return {
          schemaVersion: 1,
          id: 'canvas.crop',
          target: 'document',
          args: {
            x: readInteger(args.x, '裁剪 x', 0, 30_000),
            y: readInteger(args.y, '裁剪 y', 0, 30_000),
            width,
            height,
          },
        }
      }
      case 'canvas.rotate': {
        if (!hasExactKeys(args, ['degrees'])
          || typeof args.degrees !== 'number'
          || ![90, -90, 180, -180].includes(args.degrees)) {
          throw new Error(`第 ${commandIndex + 1} 条旋转命令仅支持 ±90 或 ±180 度`)
        }
        return {
          schemaVersion: 1,
          id: 'canvas.rotate',
          target: 'document',
          args: { degrees: args.degrees as 90 | -90 | 180 | -180 },
        }
      }
      case 'canvas.flip': {
        if (!hasExactKeys(args, ['axis']) || (args.axis !== 'h' && args.axis !== 'v')) {
          throw new Error(`第 ${commandIndex + 1} 条翻转命令仅支持 h 或 v`)
        }
        return {
          schemaVersion: 1,
          id: 'canvas.flip',
          target: 'document',
          args: { axis: args.axis },
        }
      }
      case 'canvas.flatten': {
        if (!hasExactKeys(args, [])) throw new Error(`第 ${commandIndex + 1} 条扁平化命令不接受参数`)
        return {
          schemaVersion: 1,
          id: 'canvas.flatten',
          target: 'document',
          args: {},
        }
      }
      default:
        throw new Error(`第 ${commandIndex + 1} 条命令不在 OpenShop MVP 白名单中`)
    }
  })
}

export function hasExpectedImageMagic(mimeType: string, bytes: Uint8Array): boolean {
  switch (mimeType.toLowerCase()) {
    case 'image/png':
      return bytes.length >= 8
        && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    case 'image/webp':
      return bytes.length >= 12
        && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
        && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
    default:
      return false
  }
}

export async function blobHasExpectedImageMagic(blob: Blob): Promise<boolean> {
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  return hasExpectedImageMagic(blob.type, bytes)
}

export async function dataUrlToOpenShopDocument(dataUrl: string, name: string): Promise<OpenShopDocument> {
  const response = await fetch(dataUrl)
  if (!response.ok) throw new Error(`无法读取待编辑图片：HTTP ${response.status}`)
  const blob = await response.blob()
  if (!blob.size) throw new Error('待编辑图片为空')
  return {
    blob: blob.type ? blob : new Blob([await blob.arrayBuffer()], { type: 'image/png' }),
    name,
  }
}

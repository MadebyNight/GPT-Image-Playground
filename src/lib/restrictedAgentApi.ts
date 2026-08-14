import type {
  FinalOutputSpec,
  RestrictedAgentArtifactReference,
  RestrictedAgentAssetBinding,
  RestrictedAgentCapabilities,
  RestrictedAgentExecution,
  RestrictedAgentExecutionAction,
  RestrictedAgentExecutionActionStatus,
  RestrictedAgentImageTransform,
  RestrictedAgentPlan,
  RestrictedAgentPlanGeneration,
  RestrictedAgentPlanInput,
  RestrictedAgentToolAction,
  RestrictedAgentToolOperation,
  RestrictedAgentWebSearchReference,
  TaskParams,
  ToolAgentPlan,
  ToolAgentPlanV3,
} from '../types'
import { normalizeOpenShopToolCommands } from './openshopBridge'
import { getRestrictedAgentBasePath } from './serverApiConfig'

function getAgentApiBase() {
  return getRestrictedAgentBasePath()
}

interface ApiEnvelope<T> {
  data: T
}

export interface RestrictedAgentComposerInput {
  role: 'reference' | 'mask_target'
  browserImageId: string
  sourceTaskId: string | null
  dataUrl: string
  fileName?: string
}

export interface RestrictedAgentPlanRequest {
  request: string
  size: string
  quality: TaskParams['quality']
  outputFormat: TaskParams['output_format']
  outputCompression: number | null
  moderation: TaskParams['moderation']
  imageCount: number
  webSearchEnabled?: boolean
  inputs: RestrictedAgentComposerInput[]
  mask?: {
    targetBrowserImageId: string
    dataUrl: string
    fileName?: string
  }
  temporaryProfile: {
    id: string | null
    name: string | null
    missing: boolean
  }
}

export interface RestrictedAgentPlanCreation {
  plan: RestrictedAgentPlan
  assetBindings: RestrictedAgentAssetBinding[]
}

export interface RestrictedAgentAutoPipelineRequest extends RestrictedAgentPlanRequest {
  finalOutputSpec: FinalOutputSpec
}

export interface RestrictedAgentAutoPipeline {
  plan: ToolAgentPlanV3
  execution: RestrictedAgentExecution
  assetBindings: RestrictedAgentAssetBinding[]
}

export type RestrictedAgentExecutionStateEventType =
  | 'execution.queued'
  | 'execution.started'
  | 'execution.completed'
  | 'execution.failed'
  | 'execution.cancelled'
  | 'execution.failed_unknown'

export type RestrictedAgentExecutionActionEventType =
  | 'action.queued'
  | 'action.started'
  | 'action.completed'
  | 'action.failed'
  | 'action.cancelled'
  | 'action.failed_unknown'

export type RestrictedAgentExecutionEvent =
  | {
      type: RestrictedAgentExecutionStateEventType
      data: { executionId: string; planId: string; status: RestrictedAgentExecution['status']; updatedAt: string }
    }
  | {
      type: RestrictedAgentExecutionActionEventType
      data: RestrictedAgentExecutionAction
    }
  | {
      type: 'asset.ready'
      data: { executionId: string; asset: RestrictedAgentExecution['outputAssets'][number] }
    }

export class RestrictedAgentApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'RestrictedAgentApiError'
  }
}

interface ComposerSnapshotManifest {
  schemaVersion: 2
  scope: 'tool'
  prompt: string
  inputs: Array<{
    browserImageId: string
    contentSha256: string
    role: 'reference' | 'mask_target'
    ordinal: number
  }>
  mask: {
    targetBrowserImageId: string
    contentSha256: string
  } | null
  params: {
    size: string
    quality: TaskParams['quality']
    outputFormat: TaskParams['output_format']
    outputCompression: number | null
    moderation: TaskParams['moderation']
    imageCount: number
  }
  temporaryProfile: {
    id: string | null
    name: string | null
    missing: boolean
  }
}

let capabilities: RestrictedAgentCapabilities | null = null
let capabilitiesPromise: Promise<RestrictedAgentCapabilities> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key))
}

const UUID_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i
const ISO_DATETIME_PATTERN = /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z$/

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function decodeWebSearchReference(value: unknown): RestrictedAgentWebSearchReference {
  if (!isRecord(value)
    || !hasExactKeys(value, ['enabled', 'sources'])
    || value.enabled !== true
    || !Array.isArray(value.sources)) {
    throw new Error('联网搜索来源 schema 无效')
  }
  const sources = value.sources.map((source) => {
    if (!isRecord(source)
      || !hasExactKeys(source, ['title', 'url', 'description', 'engine'])
      || !isNonEmptyString(source.title)
      || !isNonEmptyString(source.url)
      || typeof source.description !== 'string'
      || !isNonEmptyString(source.engine)) {
      throw new Error('联网搜索来源 schema 无效')
    }
    try {
      const url = new URL(source.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
    } catch {
      throw new Error('联网搜索来源 URL 无效')
    }
    return {
      title: source.title,
      url: source.url,
      description: source.description,
      engine: source.engine,
    }
  })
  return { enabled: true, sources }
}

function readApiError(payload: unknown, response: Response) {
  if (isRecord(payload) && isRecord(payload.error)) {
    const code = typeof payload.error.code === 'string' ? payload.error.code : 'gateway_error'
    const message = typeof payload.error.message === 'string' && payload.error.message.trim()
      ? payload.error.message
      : `Agent Gateway 请求失败（HTTP ${response.status}）`
    return new RestrictedAgentApiError(message, code, response.status, payload.error.details)
  }
  const message = isRecord(payload) && typeof payload.message === 'string' && payload.message.trim()
    ? payload.message
    : `Agent Gateway 请求失败（HTTP ${response.status}）`
  return new RestrictedAgentApiError(message, 'gateway_error', response.status)
}

async function readEnvelope<T>(response: Response): Promise<T> {
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    // 非 JSON 错误由统一状态文本兜底。
  }

  if (!response.ok) throw readApiError(payload, response)
  if (!isRecord(payload) || !('data' in payload)) {
    throw new RestrictedAgentApiError('Agent Gateway 返回格式无效', 'invalid_gateway_response', response.status)
  }
  return (payload as unknown as ApiEnvelope<T>).data
}

function decodeDataUrl(dataUrl: string): { mimeType: string; bytes: Uint8Array } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) throw new Error('参考图格式无效')
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return { mimeType: match[1], bytes }
}

function dataUrlToFile(dataUrl: string, fileName: string): File {
  const decoded = decodeDataUrl(dataUrl)
  return new File([Uint8Array.from(decoded.bytes).buffer], fileName, { type: decoded.mimeType })
}

function extensionForDataUrl(dataUrl: string) {
  const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1]
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/webp') return 'webp'
  return 'png'
}

async function sha256Hex(bytes: Uint8Array | string) {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持 Composer 快照 SHA-256 校验')
  const input = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : Uint8Array.from(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input.buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function normalizeComposerSnapshot(manifest: ComposerSnapshotManifest): ComposerSnapshotManifest {
  return {
    schemaVersion: 2,
    scope: 'tool',
    prompt: manifest.prompt.trim(),
    inputs: manifest.inputs.map((input) => ({
      browserImageId: input.browserImageId,
      contentSha256: input.contentSha256,
      role: input.role,
      ordinal: input.ordinal,
    })),
    mask: manifest.mask
      ? {
          targetBrowserImageId: manifest.mask.targetBrowserImageId,
          contentSha256: manifest.mask.contentSha256,
        }
      : null,
    params: {
      size: manifest.params.size,
      quality: manifest.params.quality,
      outputFormat: manifest.params.outputFormat,
      outputCompression: manifest.params.outputFormat === 'png'
        ? null
        : manifest.params.outputCompression ?? 90,
      moderation: manifest.params.moderation,
      imageCount: manifest.params.imageCount,
    },
    temporaryProfile: {
      id: manifest.temporaryProfile.id,
      name: manifest.temporaryProfile.name,
      missing: manifest.temporaryProfile.missing,
    },
  }
}

async function createComposerSnapshotManifest(input: RestrictedAgentPlanRequest): Promise<ComposerSnapshotManifest> {
  const ordinalByRole = new Map<RestrictedAgentComposerInput['role'], number>()
  const inputs = await Promise.all(input.inputs.map(async (item) => {
    const ordinal = ordinalByRole.get(item.role) ?? 0
    ordinalByRole.set(item.role, ordinal + 1)
    return {
      browserImageId: item.browserImageId,
      contentSha256: await sha256Hex(decodeDataUrl(item.dataUrl).bytes),
      role: item.role,
      ordinal,
    }
  }))
  return normalizeComposerSnapshot({
    schemaVersion: 2,
    scope: 'tool',
    prompt: input.request,
    inputs,
    mask: input.mask
      ? {
          targetBrowserImageId: input.mask.targetBrowserImageId,
          contentSha256: await sha256Hex(decodeDataUrl(input.mask.dataUrl).bytes),
        }
      : null,
    params: {
      size: input.size,
      quality: input.quality,
      outputFormat: input.outputFormat,
      outputCompression: input.outputCompression,
      moderation: input.moderation,
      imageCount: input.imageCount,
    },
    temporaryProfile: input.temporaryProfile,
  })
}

export async function hashComposerSnapshotManifest(manifest: ComposerSnapshotManifest) {
  return sha256Hex(JSON.stringify(normalizeComposerSnapshot(manifest)))
}

function decodePlanInput(value: unknown): RestrictedAgentPlanInput {
  if (!isRecord(value)
    || !hasExactKeys(value, ['assetId', 'role', 'sha256', 'mimeType', 'width', 'height'])
    || !isUuid(value.assetId)
    || !['reference', 'mask_target', 'mask'].includes(String(value.role))
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !isNonEmptyString(value.mimeType)
    || !isPositiveSafeInteger(value.width)
    || !isPositiveSafeInteger(value.height)) {
    throw new Error('计划输入 schema 无效')
  }
  return value as unknown as RestrictedAgentPlanInput
}

function decodeGeneration(value: unknown, expectedAction?: 'generate' | 'edit'): RestrictedAgentPlanGeneration {
  if (!isRecord(value)
    || !hasExactKeys(value, ['exactPrompt', 'action', 'size', 'quality', 'outputFormat', 'outputCompression', 'imageCount'])
    || !isNonEmptyString(value.exactPrompt)
    || !['generate', 'edit'].includes(String(value.action))
    || (expectedAction !== undefined && value.action !== expectedAction)
    || !isNonEmptyString(value.size)
    || !['auto', 'low', 'medium', 'high'].includes(String(value.quality))
    || !['png', 'jpeg', 'webp'].includes(String(value.outputFormat))
    || !(value.outputCompression === null
      || (typeof value.outputCompression === 'number' && Number.isSafeInteger(value.outputCompression)
        && value.outputCompression >= 0 && value.outputCompression <= 100))
    || !isPositiveSafeInteger(value.imageCount)) {
    throw new Error('图片 operation schema 无效')
  }
  return value as unknown as RestrictedAgentPlanGeneration
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isOutputFormat(value: unknown): value is NonNullable<FinalOutputSpec['outputFormat']> {
  return value === 'png' || value === 'jpeg' || value === 'webp'
}

function isFit(value: unknown): value is NonNullable<FinalOutputSpec['fit']> {
  return value === 'cover' || value === 'contain' || value === 'fill'
}

function isPosition(value: unknown): value is NonNullable<FinalOutputSpec['position']> {
  return value === 'center' || value === 'left' || value === 'right' || value === 'top' || value === 'bottom'
}

function isRotation(value: unknown): value is NonNullable<FinalOutputSpec['rotate']> {
  return value === 90 || value === -90 || value === 180 || value === -180
}

function decodeCrop(value: unknown): NonNullable<FinalOutputSpec['crop']> {
  if (!isRecord(value)
    || !hasExactKeys(value, ['x', 'y', 'width', 'height'])
    || !isNonNegativeSafeInteger(value.x)
    || !isNonNegativeSafeInteger(value.y)
    || !isPositiveSafeInteger(value.width)
    || !isPositiveSafeInteger(value.height)
    || value.width > 30_000
    || value.height > 30_000
    || value.width * value.height > 80_000_000) {
    throw new Error('最终输出裁剪 schema 无效')
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

interface DecodeOutputSpecOptions {
  requireOutputFormat?: boolean
  requireOutputCompression?: boolean
  allowTransparent?: boolean
}

function decodeFinalOutputSpec(value: unknown, options: DecodeOutputSpecOptions = {}): FinalOutputSpec {
  const fields = [
    'width', 'height', 'fit', 'position', 'crop', 'rotate', 'flip', 'outputFormat',
    'transparent', 'background', 'outputCompression',
  ] as const
  if (!isRecord(value) || !hasExactKeys(value, [], fields)) throw new Error('最终输出规格 schema 无效')
  if (options.allowTransparent === false && Object.prototype.hasOwnProperty.call(value, 'transparent')) {
    throw new Error('图片变换不支持 transparent 字段')
  }

  const width = value.width
  const height = value.height
  if (!(width === undefined || (isPositiveSafeInteger(width) && width <= 30_000))
    || !(height === undefined || (isPositiveSafeInteger(height) && height <= 30_000))
    || (width === undefined) !== (height === undefined)
    || (typeof width === 'number' && typeof height === 'number' && width * height > 80_000_000)) {
    throw new Error('最终输出尺寸 schema 无效')
  }
  if (value.fit !== undefined && !isFit(value.fit)) throw new Error('最终输出 fit schema 无效')
  if (value.position !== undefined && !isPosition(value.position)) throw new Error('最终输出 position schema 无效')
  if (value.rotate !== undefined && !isRotation(value.rotate)) throw new Error('最终输出旋转 schema 无效')
  if (value.flip !== undefined && value.flip !== 'horizontal' && value.flip !== 'vertical') {
    throw new Error('最终输出翻转 schema 无效')
  }
  if (value.background !== undefined && (!isNonEmptyString(value.background) || value.background.trim() !== value.background || value.background.length > 128)) {
    throw new Error('最终输出背景 schema 无效')
  }
  if (value.transparent !== undefined && typeof value.transparent !== 'boolean') {
    throw new Error('最终输出透明度 schema 无效')
  }
  if (value.outputFormat !== undefined && !isOutputFormat(value.outputFormat)) {
    throw new Error('最终输出格式 schema 无效')
  }
  if (options.requireOutputFormat && value.outputFormat === undefined) {
    throw new Error('最终输出缺少 outputFormat')
  }
  if (value.outputCompression !== undefined
    && value.outputCompression !== null
    && (!isNonNegativeSafeInteger(value.outputCompression) || value.outputCompression > 100)) {
    throw new Error('最终输出压缩 schema 无效')
  }
  if (options.requireOutputCompression && value.outputCompression === undefined) {
    throw new Error('最终输出缺少 outputCompression')
  }
  if (value.outputFormat === 'png' && value.outputCompression !== undefined && value.outputCompression !== null) {
    throw new Error('PNG 输出压缩必须为 null')
  }
  if (value.outputFormat === 'jpeg' && value.transparent === true) {
    throw new Error('JPEG 不支持透明输出')
  }

  return {
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(value.fit === undefined ? {} : { fit: value.fit }),
    ...(value.position === undefined ? {} : { position: value.position }),
    ...(value.crop === undefined ? {} : { crop: decodeCrop(value.crop) }),
    ...(value.rotate === undefined ? {} : { rotate: value.rotate }),
    ...(value.flip === undefined ? {} : { flip: value.flip }),
    ...(value.outputFormat === undefined ? {} : { outputFormat: value.outputFormat }),
    ...(value.transparent === undefined ? {} : { transparent: value.transparent }),
    ...(value.background === undefined ? {} : { background: value.background }),
    ...(value.outputCompression === undefined ? {} : { outputCompression: value.outputCompression }),
  }
}

function decodeImageTransform(value: unknown): RestrictedAgentImageTransform {
  if (!isRecord(value)
    || !hasExactKeys(value, [], [
      'width', 'height', 'fit', 'position', 'crop', 'rotate', 'flip', 'background', 'outputFormat', 'outputCompression',
    ])) {
    throw new Error('图片变换 schema 无效')
  }
  const transform = decodeFinalOutputSpec(value, {
    requireOutputFormat: true,
    requireOutputCompression: true,
    allowTransparent: false,
  })
  return transform as RestrictedAgentImageTransform
}

function decodeArtifactReference(value: unknown): RestrictedAgentArtifactReference {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('action 产物引用 schema 无效')
  if (value.kind === 'plan_input') {
    if (!hasExactKeys(value, ['kind', 'assetId']) || !isUuid(value.assetId)) {
      throw new Error('计划输入产物引用 schema 无效')
    }
    return { kind: 'plan_input', assetId: value.assetId }
  }
  if (value.kind === 'action_output') {
    if (!hasExactKeys(value, ['kind', 'actionIndex'])
      || !isNonNegativeSafeInteger(value.actionIndex)
      || value.actionIndex > 2) {
      throw new Error('action 输出引用 schema 无效')
    }
    return { kind: 'action_output', actionIndex: value.actionIndex }
  }
  throw new Error('action 产物引用类型无效')
}

function decodeRestrictedAgentToolAction(value: unknown): RestrictedAgentToolAction {
  if (!isRecord(value) || typeof value.type !== 'string') throw new Error('v3 action schema 无效')
  if (value.type === 'image.generate') {
    if (!hasExactKeys(value, ['type', 'generation'])) throw new Error('图片 action 含未知字段')
    return {
      type: 'image.generate',
      generation: decodeGeneration(value.generation, 'generate') as RestrictedAgentPlanGeneration & { action: 'generate' },
    }
  }
  if (value.type === 'image.edit') {
    if (!hasExactKeys(value, ['type', 'generation'])) throw new Error('图片 action 含未知字段')
    return {
      type: 'image.edit',
      generation: decodeGeneration(value.generation, 'edit') as RestrictedAgentPlanGeneration & { action: 'edit' },
    }
  }
  if (value.type === 'image.transform') {
    if (!hasExactKeys(value, ['type', 'input', 'transform'])) throw new Error('图片变换 action 含未知字段')
    return {
      type: 'image.transform',
      input: decodeArtifactReference(value.input),
      transform: decodeImageTransform(value.transform),
    }
  }
  if (value.type === 'metadata.assert') {
    if (!hasExactKeys(value, ['type', 'input', 'expected'])) throw new Error('输出断言 action 含未知字段')
    return {
      type: 'metadata.assert',
      input: decodeArtifactReference(value.input),
      expected: decodeFinalOutputSpec(value.expected, { requireOutputFormat: true, requireOutputCompression: true }),
    }
  }
  throw new Error('计划包含未知 v3 action')
}

function sameCrop(left: FinalOutputSpec['crop'], right: FinalOutputSpec['crop']) {
  return left?.x === right?.x
    && left?.y === right?.y
    && left?.width === right?.width
    && left?.height === right?.height
}

function transformMatchesFinalOutputSpec(transform: RestrictedAgentImageTransform, expected: FinalOutputSpec) {
  return transform.width === expected.width
    && transform.height === expected.height
    && transform.fit === expected.fit
    && transform.position === expected.position
    && sameCrop(transform.crop, expected.crop)
    && transform.rotate === expected.rotate
    && transform.flip === expected.flip
    && transform.outputFormat === expected.outputFormat
    && transform.background === expected.background
    && transform.outputCompression === expected.outputCompression
}

function sameFinalOutputSpec(left: FinalOutputSpec, right: FinalOutputSpec) {
  return transformMatchesFinalOutputSpec(left as RestrictedAgentImageTransform, right)
    && left.transparent === right.transparent
}

function validateV3ActionChain(
  actions: RestrictedAgentToolAction[],
  inputs: RestrictedAgentPlanInput[],
  finalOutputSpec: FinalOutputSpec,
) {
  const first = actions[0]
  const second = actions[1]
  const third = actions[2]
  const planInputIsEditable = (reference: RestrictedAgentArtifactReference) => reference.kind === 'plan_input'
    && inputs.some((input) => input.assetId === reference.assetId && input.role !== 'mask')

  if (actions.length === 3
    && (first?.type === 'image.generate' || first?.type === 'image.edit')
    && second?.type === 'image.transform'
    && third?.type === 'metadata.assert') {
    if (first.generation.imageCount !== 1
      || second.input.kind !== 'action_output' || second.input.actionIndex !== 0
      || third.input.kind !== 'action_output' || third.input.actionIndex !== 1
      || !transformMatchesFinalOutputSpec(second.transform, finalOutputSpec)
      || !sameFinalOutputSpec(third.expected, finalOutputSpec)) {
      throw new Error('v3 action 链与最终输出规格不一致')
    }
    return
  }
  if (actions.length === 2
    && first?.type === 'image.transform'
    && second?.type === 'metadata.assert'
    && planInputIsEditable(first.input)
    && second.input.kind === 'action_output'
    && second.input.actionIndex === 0
    && transformMatchesFinalOutputSpec(first.transform, finalOutputSpec)
    && sameFinalOutputSpec(second.expected, finalOutputSpec)) {
    return
  }
  throw new Error('v3 action 链顺序或产物引用无效')
}

function decodeOperation(value: unknown): RestrictedAgentToolOperation {
  if (!isRecord(value) || typeof value.type !== 'string') throw new Error('计划 operation schema 无效')
  if (value.type === 'image.generate' || value.type === 'image.edit') {
    if (!hasExactKeys(value, ['type', 'generation'])) throw new Error('图片 operation 含未知字段')
    return {
      type: value.type,
      generation: decodeGeneration(value.generation, value.type === 'image.generate' ? 'generate' : 'edit'),
    } as RestrictedAgentToolOperation
  }
  if (value.type === 'openshop.edit') {
    if (!hasExactKeys(value, ['type', 'inputAssetId', 'commands', 'outputFormat'])
      || !isUuid(value.inputAssetId)
      || value.outputFormat !== 'png') {
      throw new Error('OpenShop operation schema 无效')
    }
    return {
      type: 'openshop.edit',
      inputAssetId: value.inputAssetId,
      commands: normalizeOpenShopToolCommands(value.commands),
      outputFormat: 'png',
    }
  }
  throw new Error('计划包含未知 operation')
}

export function decodeRestrictedAgentPlan(value: unknown): RestrictedAgentPlan {
  if (!isRecord(value)) throw new Error('Agent Gateway 计划格式无效')
  const commonRequired = [
    'id', 'version', 'status', 'expiresAt', 'originalRequest', 'summary', 'inputs',
    'assumptions', 'warnings', 'policyVersion',
  ] as const
  if (!isNonEmptyString(value.id)
    || !isPositiveSafeInteger(value.version)
    || !['awaiting_confirmation', 'queued', 'executing', 'completed', 'failed', 'cancelled', 'failed_unknown', 'expired'].includes(String(value.status))
    || typeof value.expiresAt !== 'string' || !ISO_DATETIME_PATTERN.test(value.expiresAt)
    || typeof value.originalRequest !== 'string'
    || !isNonEmptyString(value.summary)
    || !isStringArray(value.assumptions)
    || !isStringArray(value.warnings)
    || !isNonEmptyString(value.policyVersion)) {
    throw new Error('计划公共字段 schema 无效')
  }
  if (value.schemaVersion === undefined) {
    if (!hasExactKeys(value, [...commonRequired, 'steps', 'generation'], ['webSearch'])) throw new Error('旧版计划 schema 无效')
    if (!Array.isArray(value.steps) || value.steps.length < 1 || !Array.isArray(value.inputs)) throw new Error('旧版计划 schema 无效')
    const generation = decodeGeneration(value.generation)
    const steps = value.steps.map((step) => {
      if (!isRecord(step)
        || !hasExactKeys(step, ['title', 'operation'])
        || !isNonEmptyString(step.title)
        || !['generate', 'edit'].includes(String(step.operation))) throw new Error('旧版计划步骤 schema 无效')
      return step as unknown as { title: string; operation: 'generate' | 'edit' }
    })
    if (steps.some((step) => step.operation !== generation.action)) throw new Error('旧版计划步骤与generation不一致')
    return {
      ...value,
      steps,
      generation,
      inputs: value.inputs.map(decodePlanInput),
      ...(value.webSearch === undefined ? {} : { webSearch: decodeWebSearchReference(value.webSearch) }),
    } as unknown as RestrictedAgentPlan
  }
  if (value.schemaVersion === 3) {
    if (!hasExactKeys(value, [
      ...commonRequired,
      'schemaVersion', 'composerSnapshotHash', 'finalOutputSpec', 'actions',
    ], ['webSearch'])
      || !isSha256(value.composerSnapshotHash)
      || !Array.isArray(value.inputs)
      || !Array.isArray(value.actions)) {
      throw new Error('v3 Tool Plan schema 无效')
    }
    const inputs = value.inputs.map(decodePlanInput)
    const finalOutputSpec = decodeFinalOutputSpec(value.finalOutputSpec, {
      requireOutputFormat: true,
      requireOutputCompression: true,
    })
    const actions = value.actions.map(decodeRestrictedAgentToolAction)
    validateV3ActionChain(actions, inputs, finalOutputSpec)
    return {
      ...value,
      schemaVersion: 3,
      composerSnapshotHash: value.composerSnapshotHash,
      finalOutputSpec,
      actions,
      inputs,
      ...(value.webSearch === undefined ? {} : { webSearch: decodeWebSearchReference(value.webSearch) }),
    } as unknown as ToolAgentPlanV3
  }
  if (value.schemaVersion !== 2
    || !hasExactKeys(value, [...commonRequired, 'schemaVersion', 'composerSnapshotHash', 'operation'], ['webSearch'])
    || !isSha256(value.composerSnapshotHash)
    || !Array.isArray(value.inputs)) {
    throw new Error('Tool Plan schema 无效')
  }
  const inputs = value.inputs.map(decodePlanInput)
  const operation = decodeOperation(value.operation)
  if (operation.type === 'openshop.edit'
    && !inputs.some((input) => input.assetId === operation.inputAssetId && input.role === 'reference')) {
    throw new Error('OpenShop inputAssetId 未引用计划中的参考图')
  }
  return {
    ...value,
    schemaVersion: 2,
    operation,
    inputs,
    ...(value.webSearch === undefined ? {} : { webSearch: decodeWebSearchReference(value.webSearch) }),
  } as unknown as ToolAgentPlan
}

function decodeExecutionAsset(value: unknown): RestrictedAgentExecution['outputAssets'][number] {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'url', 'mimeType', 'sha256', 'width', 'height', 'byteSize'])
    || !isUuid(value.id)
    || !isNonEmptyString(value.url)
    || !isNonEmptyString(value.mimeType)
    || !isSha256(value.sha256)
    || !isPositiveSafeInteger(value.width)
    || !isPositiveSafeInteger(value.height)
    || !isNonNegativeSafeInteger(value.byteSize)) {
    throw new Error('执行产物 schema 无效')
  }
  return {
    id: value.id,
    url: value.url,
    mimeType: value.mimeType,
    sha256: value.sha256,
    width: value.width,
    height: value.height,
    byteSize: value.byteSize,
  }
}

function decodeExecutionError(value: unknown, label: string): { code: string; message: string } | null {
  if (value === null) return null
  if (!isRecord(value)
    || !hasExactKeys(value, ['code', 'message'])
    || !isNonEmptyString(value.code)
    || !isNonEmptyString(value.message)) {
    throw new Error(`${label}错误 schema 无效`)
  }
  return { code: value.code, message: value.message }
}

function decodeRestrictedAgentExecutionAction(value: unknown): RestrictedAgentExecutionAction {
  const statuses: RestrictedAgentExecutionActionStatus[] = [
    'queued', 'executing', 'completed', 'failed', 'cancelled', 'failed_unknown',
  ]
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'id', 'executionId', 'actionIndex', 'type', 'normalizedParams', 'status', 'idempotencyKey', 'error',
      'inputAssets', 'outputAssets', 'createdAt', 'startedAt', 'completedAt', 'updatedAt',
    ])
    || !isUuid(value.id)
    || !isUuid(value.executionId)
    || !isNonNegativeSafeInteger(value.actionIndex)
    || value.actionIndex > 2
    || typeof value.type !== 'string'
    || !statuses.includes(value.status as RestrictedAgentExecutionActionStatus)
    || !isSha256(value.idempotencyKey)
    || !Array.isArray(value.inputAssets)
    || !Array.isArray(value.outputAssets)
    || typeof value.createdAt !== 'string' || !ISO_DATETIME_PATTERN.test(value.createdAt)
    || !(value.startedAt === null || (typeof value.startedAt === 'string' && ISO_DATETIME_PATTERN.test(value.startedAt)))
    || !(value.completedAt === null || (typeof value.completedAt === 'string' && ISO_DATETIME_PATTERN.test(value.completedAt)))
    || typeof value.updatedAt !== 'string' || !ISO_DATETIME_PATTERN.test(value.updatedAt)) {
    throw new Error('执行 action schema 无效')
  }
  const normalizedParams = decodeRestrictedAgentToolAction(value.normalizedParams)
  if (normalizedParams.type !== value.type) throw new Error('执行 action 类型与规范参数不一致')
  return {
    id: value.id,
    executionId: value.executionId,
    actionIndex: value.actionIndex,
    type: normalizedParams.type,
    normalizedParams,
    status: value.status as RestrictedAgentExecutionActionStatus,
    idempotencyKey: value.idempotencyKey,
    error: decodeExecutionError(value.error, '执行 action '),
    inputAssets: value.inputAssets.map(decodeExecutionAsset),
    outputAssets: value.outputAssets.map(decodeExecutionAsset),
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    updatedAt: value.updatedAt,
  }
}

export function decodeRestrictedAgentExecution(value: unknown): RestrictedAgentExecution {
  const statuses: RestrictedAgentExecution['status'][] = [
    'queued', 'executing', 'completed', 'failed', 'cancelled', 'failed_unknown',
  ]
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'id', 'planId', 'status', 'cancelRequested', 'error', 'outputAssets',
      'createdAt', 'startedAt', 'completedAt', 'updatedAt',
    ], ['actions'])
    || !isUuid(value.id)
    || !isUuid(value.planId)
    || !statuses.includes(value.status as RestrictedAgentExecution['status'])
    || typeof value.cancelRequested !== 'boolean'
    || !Array.isArray(value.outputAssets)
    || !(value.actions === undefined || Array.isArray(value.actions))
    || typeof value.createdAt !== 'string' || !ISO_DATETIME_PATTERN.test(value.createdAt)
    || !(value.startedAt === null || (typeof value.startedAt === 'string' && ISO_DATETIME_PATTERN.test(value.startedAt)))
    || !(value.completedAt === null || (typeof value.completedAt === 'string' && ISO_DATETIME_PATTERN.test(value.completedAt)))
    || typeof value.updatedAt !== 'string' || !ISO_DATETIME_PATTERN.test(value.updatedAt)) {
    throw new Error('执行 schema 无效')
  }
  const actions = (value.actions ?? []).map(decodeRestrictedAgentExecutionAction)
  const actionIds = new Set<string>()
  for (const [index, action] of actions.entries()) {
    if (action.executionId !== value.id
      || action.actionIndex !== index
      || actionIds.has(action.id)) {
      throw new Error('执行 action 与执行记录不一致')
    }
    actionIds.add(action.id)
  }
  return {
    id: value.id,
    planId: value.planId,
    status: value.status as RestrictedAgentExecution['status'],
    cancelRequested: value.cancelRequested,
    error: decodeExecutionError(value.error, '执行 '),
    outputAssets: value.outputAssets.map(decodeExecutionAsset),
    actions,
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    updatedAt: value.updatedAt,
  }
}

export function decodeRestrictedAgentAutoPipeline(value: unknown): RestrictedAgentAutoPipeline {
  if (!isRecord(value) || !hasExactKeys(value, ['plan', 'execution', 'assetBindings'])) {
    throw new Error('自动执行响应 schema 无效')
  }
  const plan = decodeRestrictedAgentPlan(value.plan)
  if (plan.schemaVersion !== 3) throw new Error('自动执行响应必须包含 v3 计划')
  const execution = decodeRestrictedAgentExecution(value.execution)
  const assetBindings = decodeRestrictedAgentAssetBindings(plan, value.assetBindings)
  if (execution.planId !== plan.id
    || execution.actions?.length !== plan.actions.length
    || execution.actions?.some((action, index) => action.actionIndex !== index || action.type !== plan.actions[index]?.type)) {
    throw new Error('自动执行响应中的计划与执行不一致')
  }
  return { plan, execution, assetBindings }
}

export function decodeRestrictedAgentExecutionEvent(
  type: string,
  value: unknown,
): RestrictedAgentExecutionEvent {
  const executionEventStatuses: Record<RestrictedAgentExecutionStateEventType, RestrictedAgentExecution['status']> = {
    'execution.queued': 'queued',
    'execution.started': 'executing',
    'execution.completed': 'completed',
    'execution.failed': 'failed',
    'execution.cancelled': 'cancelled',
    'execution.failed_unknown': 'failed_unknown',
  }
  if (type in executionEventStatuses) {
    const eventType = type as RestrictedAgentExecutionStateEventType
    if (!isRecord(value)
      || !hasExactKeys(value, ['executionId', 'planId', 'status', 'updatedAt'])
      || !isUuid(value.executionId)
      || !isUuid(value.planId)
      || value.status !== executionEventStatuses[eventType]
      || typeof value.updatedAt !== 'string' || !ISO_DATETIME_PATTERN.test(value.updatedAt)) {
      throw new Error('执行状态 SSE schema 无效')
    }
    return {
      type: eventType,
      data: {
        executionId: value.executionId,
        planId: value.planId,
        status: value.status as RestrictedAgentExecution['status'],
        updatedAt: value.updatedAt,
      },
    }
  }

  const actionEventStatuses: Record<RestrictedAgentExecutionActionEventType, RestrictedAgentExecutionActionStatus> = {
    'action.queued': 'queued',
    'action.started': 'executing',
    'action.completed': 'completed',
    'action.failed': 'failed',
    'action.cancelled': 'cancelled',
    'action.failed_unknown': 'failed_unknown',
  }
  if (type in actionEventStatuses) {
    const eventType = type as RestrictedAgentExecutionActionEventType
    const action = decodeRestrictedAgentExecutionAction(value)
    if (action.status !== actionEventStatuses[eventType]) throw new Error('执行 action SSE 状态不一致')
    return { type: eventType, data: action }
  }

  if (type === 'asset.ready') {
    if (!isRecord(value)
      || !hasExactKeys(value, ['executionId', 'asset'])
      || !isUuid(value.executionId)) {
      throw new Error('执行产物 SSE schema 无效')
    }
    return { type: 'asset.ready', data: { executionId: value.executionId, asset: decodeExecutionAsset(value.asset) } }
  }
  throw new Error('未知执行 SSE 事件')
}

export function decodeRestrictedAgentAssetBindings(
  plan: RestrictedAgentPlan,
  value: unknown,
): RestrictedAgentAssetBinding[] {
  if (!Array.isArray(value)) throw new Error('计划 asset binding schema 无效')
  const bindings = value.map((candidate) => {
    if (!isRecord(candidate)
      || !hasExactKeys(candidate, ['gatewayAssetId', 'browserImageId', 'sourceTaskId', 'role', 'ordinal'])
      || !isUuid(candidate.gatewayAssetId)
      || !(candidate.browserImageId === null || isNonEmptyString(candidate.browserImageId))
      || !(candidate.sourceTaskId === null || isNonEmptyString(candidate.sourceTaskId))
      || !['reference', 'mask_target', 'mask'].includes(String(candidate.role))
      || !isNonNegativeSafeInteger(candidate.ordinal)) {
      throw new Error('计划 asset binding schema 无效')
    }
    return candidate as unknown as RestrictedAgentAssetBinding
  })
  if (bindings.length !== plan.inputs.length) throw new Error('计划 asset binding 数量不一致')
  const gatewayAssetIds = new Set<string>()
  const browserImageIds = new Set<string>()
  const inputCountByRole = new Map<RestrictedAgentPlanInput['role'], number>()
  const bindingOrdinalsByRole = new Map<RestrictedAgentPlanInput['role'], Set<number>>()
  for (const [index, input] of plan.inputs.entries()) {
    inputCountByRole.set(input.role, (inputCountByRole.get(input.role) ?? 0) + 1)
    const binding = bindings[index]
    const roleOrdinals = bindingOrdinalsByRole.get(input.role) ?? new Set<number>()
    if (!binding
      || binding.gatewayAssetId !== input.assetId
      || binding.role !== input.role
      || (input.role === 'mask'
        ? binding.browserImageId !== null || binding.sourceTaskId !== null
        : binding.browserImageId === null)
      || gatewayAssetIds.has(binding.gatewayAssetId)
      || (binding.browserImageId !== null && browserImageIds.has(binding.browserImageId))
      || roleOrdinals.has(binding.ordinal)) {
      throw new Error('计划 asset binding 与计划输入不一致')
    }
    gatewayAssetIds.add(binding.gatewayAssetId)
    if (binding.browserImageId !== null) browserImageIds.add(binding.browserImageId)
    roleOrdinals.add(binding.ordinal)
    bindingOrdinalsByRole.set(input.role, roleOrdinals)
  }
  for (const [role, inputCount] of inputCountByRole) {
    const ordinals = bindingOrdinalsByRole.get(role)
    if (!ordinals
      || ordinals.size !== inputCount
      || [...ordinals].some((ordinal) => ordinal >= inputCount)) {
      throw new Error('计划 asset binding 与计划输入不一致')
    }
  }
  if (plan.schemaVersion === 2) {
    const operation = getRestrictedAgentPlanOperation(plan)
    if (operation.type === 'openshop.edit'
      && !bindings.some((binding) => binding.gatewayAssetId === operation.inputAssetId && binding.browserImageId !== null)) {
      throw new Error('OpenShop inputAssetId 缺少浏览器 IndexedDB binding')
    }
  }
  return bindings
}

export function getRestrictedAgentPlanOperation(plan: RestrictedAgentPlan): RestrictedAgentToolOperation {
  if (plan.schemaVersion === 3) throw new Error('v3 action 链没有单一 operation')
  if (plan.schemaVersion === 2) return plan.operation
  return {
    type: plan.generation.action === 'generate' ? 'image.generate' : 'image.edit',
    generation: plan.generation,
  } as RestrictedAgentToolOperation
}

function createBindings(
  plan: RestrictedAgentPlan,
  input: RestrictedAgentPlanRequest,
): RestrictedAgentAssetBinding[] {
  const localByBinding = new Map<string, { browserImageId: string | null; sourceTaskId: string | null }>()
  const ordinalByRole = new Map<RestrictedAgentComposerInput['role'], number>()
  for (const item of input.inputs) {
    const ordinal = ordinalByRole.get(item.role) ?? 0
    ordinalByRole.set(item.role, ordinal + 1)
    localByBinding.set(`${item.role}:${ordinal}`, {
      browserImageId: item.browserImageId,
      sourceTaskId: item.sourceTaskId,
    })
  }
  if (input.mask) localByBinding.set('mask:0', { browserImageId: null, sourceTaskId: null })

  const planOrdinals = new Map<RestrictedAgentPlanInput['role'], number>()
  const bindings = plan.inputs.map((planInput) => {
    const ordinal = planOrdinals.get(planInput.role) ?? 0
    planOrdinals.set(planInput.role, ordinal + 1)
    const local = localByBinding.get(`${planInput.role}:${ordinal}`)
    if (!local) throw new Error('Gateway 计划输入无法建立浏览器 asset binding')
    localByBinding.delete(`${planInput.role}:${ordinal}`)
    return {
      gatewayAssetId: planInput.assetId,
      browserImageId: local.browserImageId,
      sourceTaskId: local.sourceTaskId,
      role: planInput.role,
      ordinal,
    }
  })
  if (localByBinding.size > 0) throw new Error('Gateway 计划输入 asset binding 数量不一致')
  if (plan.schemaVersion === 2) {
    const operation = getRestrictedAgentPlanOperation(plan)
    if (operation.type === 'openshop.edit'
      && !bindings.some((binding) => binding.gatewayAssetId === operation.inputAssetId && binding.browserImageId)) {
      throw new Error('OpenShop inputAssetId 缺少浏览器 IndexedDB binding')
    }
  }
  return bindings
}

function bindingsMatchPlan(
  plan: ToolAgentPlan,
  bindings: RestrictedAgentAssetBinding[],
  request: RestrictedAgentPlanRequest,
) {
  try {
    decodeRestrictedAgentAssetBindings(plan, bindings)
  } catch {
    return false
  }
  const planOrdinals = new Map<RestrictedAgentPlanInput['role'], number>()
  const planKeys = plan.inputs.map((input) => {
    const ordinal = planOrdinals.get(input.role) ?? 0
    planOrdinals.set(input.role, ordinal + 1)
    return `${input.role}:${ordinal}:${input.assetId}`
  })
  const bindingKeys = bindings.map((binding) => `${binding.role}:${binding.ordinal}:${binding.gatewayAssetId}`)
  if (planKeys.length !== bindingKeys.length || planKeys.some((key, index) => key !== bindingKeys[index])) return false

  const requestOrdinals = new Map<RestrictedAgentComposerInput['role'], number>()
  const requestBindings = request.inputs.map((input) => {
    const ordinal = requestOrdinals.get(input.role) ?? 0
    requestOrdinals.set(input.role, ordinal + 1)
    return { input, ordinal }
  })
  if (bindings.filter((binding) => binding.role !== 'mask').length !== requestBindings.length) return false
  for (const { input, ordinal } of requestBindings) {
    const binding = bindings.find((candidate) => candidate.role === input.role && candidate.ordinal === ordinal)
    if (!binding
      || binding.browserImageId !== input.browserImageId
      || binding.sourceTaskId !== input.sourceTaskId) return false
  }
  const maskBindings = bindings.filter((binding) => binding.role === 'mask')
  if (Boolean(request.mask) !== (maskBindings.length === 1)) return false
  if (getRestrictedAgentPlanOperation(plan).type === 'openshop.edit') {
    const operation = getRestrictedAgentPlanOperation(plan)
    if (operation.type === 'openshop.edit'
      && !bindings.some((binding) => binding.gatewayAssetId === operation.inputAssetId && binding.browserImageId)) return false
  }
  return true
}

export async function computeRestrictedAgentConfirmationHash(
  plan: RestrictedAgentPlan,
  bindings: RestrictedAgentAssetBinding[],
  input: RestrictedAgentPlanRequest,
): Promise<string | null> {
  if (plan.schemaVersion !== 2) return null
  if (!bindingsMatchPlan(plan, bindings, input)) return null
  return hashComposerSnapshotManifest(await createComposerSnapshotManifest(input))
}

export async function getRestrictedAgentCapabilities(options: { refresh?: boolean; signal?: AbortSignal } = {}) {
  if (!options.refresh && capabilities) return capabilities
  if (!options.refresh && capabilitiesPromise && !options.signal) return capabilitiesPromise

  const request = fetch(`${getAgentApiBase()}/capabilities`, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: options.signal,
  })
    .then((response) => readEnvelope<RestrictedAgentCapabilities>(response))
    .then((next) => {
      if (!next.enabled) throw new Error('受限 Agent 当前未启用')
      if (!next.csrfToken) throw new Error('Agent Gateway 未返回 CSRF Token')
      capabilities = next
      return next
    })

  // 带 signal 的探测归属于单个交互回合。不能将它登记为全局 pending promise，
  // 否则该回合取消会让并发的普通 Gateway 请求收到同一个 AbortError。
  if (options.signal) return request

  let pending: Promise<RestrictedAgentCapabilities>
  pending = request.finally(() => {
    // 并发 refresh 可能已登记了更新的请求，旧请求完成时不能清空它。
    if (capabilitiesPromise === pending) capabilitiesPromise = null
  })
  capabilitiesPromise = pending
  return pending
}

async function postWithCsrf<T>(path: string, init: Omit<RequestInit, 'method'> = {}) {
  const capability = await getRestrictedAgentCapabilities()
  const request = () => fetch(`${getAgentApiBase()}${path}`, {
    ...init,
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'X-CSRF-Token': capability.csrfToken,
      ...init.headers,
    },
  })

  let response = await request()
  if (response.status === 403) {
    const refreshed = await getRestrictedAgentCapabilities({ refresh: true })
    response = await fetch(`${getAgentApiBase()}${path}`, {
      ...init,
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'X-CSRF-Token': refreshed.csrfToken,
        ...init.headers,
      },
    })
  }
  return readEnvelope<T>(response)
}

async function createPlanForm(input: RestrictedAgentPlanRequest) {
  const manifest = await createComposerSnapshotManifest(input)
  const expectedHash = await hashComposerSnapshotManifest(manifest)
  const form = new FormData()
  form.set('request', input.request.trim())
  form.set('size', input.size)
  form.set('quality', input.quality)
  form.set('outputFormat', input.outputFormat)
  if (input.outputCompression != null) form.set('outputCompression', String(input.outputCompression))
  form.set('imageCount', String(input.imageCount))
  form.set('webSearchEnabled', String(input.webSearchEnabled === true))
  form.set('composerSnapshot', JSON.stringify(manifest))

  input.inputs.forEach((image, index) => {
    const name = image.fileName ?? `input-${index + 1}.${extensionForDataUrl(image.dataUrl)}`
    form.append(image.role, dataUrlToFile(image.dataUrl, name))
  })
  if (input.mask) {
    const name = input.mask.fileName ?? `mask.${extensionForDataUrl(input.mask.dataUrl)}`
    form.set('mask', dataUrlToFile(input.mask.dataUrl, name))
  }

  return { form, expectedHash }
}

export async function createRestrictedAgentPlan(input: RestrictedAgentPlanRequest): Promise<RestrictedAgentPlanCreation> {
  const { form, expectedHash } = await createPlanForm(input)

  const plan = decodeRestrictedAgentPlan(await postWithCsrf<unknown>('/plans', { body: form }))
  if (plan.schemaVersion !== 2 || plan.composerSnapshotHash !== expectedHash) {
    throw new Error('Gateway 返回的 Composer 快照哈希与本地冻结输入不一致')
  }
  return { plan, assetBindings: createBindings(plan, input) }
}

/** 创建并自动入队 v3 action 链；不会调用旧的确认执行端点。 */
export async function createAutoPipeline(input: RestrictedAgentAutoPipelineRequest): Promise<RestrictedAgentAutoPipeline> {
  if (input.imageCount !== 1) throw new Error('严格输出 Tool Pipeline 只能生成一张图片')
  const finalOutputSpec = decodeFinalOutputSpec(input.finalOutputSpec)
  const { form, expectedHash } = await createPlanForm(input)
  form.set('finalOutputSpec', JSON.stringify(finalOutputSpec))

  const pipeline = decodeRestrictedAgentAutoPipeline(
    await postWithCsrf<unknown>('/plans/auto-execute', { body: form }),
  )
  if (pipeline.plan.composerSnapshotHash !== expectedHash) {
    throw new Error('Gateway 返回的 Composer 快照哈希与本地冻结输入不一致')
  }
  return pipeline
}

export function getRestrictedAgentPlan(planId: string) {
  return fetch(`${getAgentApiBase()}/plans/${encodeURIComponent(planId)}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
    .then((response) => readEnvelope<unknown>(response))
    .then(decodeRestrictedAgentPlan)
}

export function executeRestrictedAgentPlan(plan: RestrictedAgentPlan, composerSnapshotHash?: string | null) {
  if (plan.schemaVersion === 3) {
    return Promise.reject(new Error('v3 action 链必须通过自动执行接口创建'))
  }
  if (plan.schemaVersion === 2 && !composerSnapshotHash) {
    return Promise.reject(new Error('确认 Tool Plan 前必须重新计算 Composer 快照哈希'))
  }
  return postWithCsrf<unknown>(`/plans/${encodeURIComponent(plan.id)}/execute`, {
    headers: {
      'If-Match': `"${plan.version}"`,
      ...(composerSnapshotHash ? { 'X-Composer-Snapshot-Hash': composerSnapshotHash } : {}),
    },
  }).then(decodeRestrictedAgentExecution)
}

export function getRestrictedAgentExecution(executionId: string) {
  return fetch(`${getAgentApiBase()}/executions/${encodeURIComponent(executionId)}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
    .then((response) => readEnvelope<unknown>(response))
    .then(decodeRestrictedAgentExecution)
}

export function cancelRestrictedAgentExecution(executionId: string) {
  return postWithCsrf<unknown>(`/executions/${encodeURIComponent(executionId)}/cancel`)
    .then(decodeRestrictedAgentExecution)
}

export async function getRestrictedAgentAsset(assetId: string) {
  const response = await fetch(`${getAgentApiBase()}/assets/${encodeURIComponent(assetId)}`, {
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Agent 图片资源读取失败（HTTP ${response.status}）`)
  return response.blob()
}

export function subscribeRestrictedAgentExecution(
  executionId: string,
  listener: (event: RestrictedAgentExecutionEvent) => void,
  onDisconnect: () => void,
) {
  const source = new EventSource(`${getAgentApiBase()}/executions/${encodeURIComponent(executionId)}/events`, {
    withCredentials: true,
  })
  const eventTypes: RestrictedAgentExecutionEvent['type'][] = [
    'execution.queued',
    'execution.started',
    'execution.completed',
    'execution.failed',
    'execution.cancelled',
    'execution.failed_unknown',
    'asset.ready',
    'action.queued',
    'action.started',
    'action.completed',
    'action.failed',
    'action.cancelled',
    'action.failed_unknown',
  ]
  const handlers = eventTypes.map((type) => {
    const handler = (event: MessageEvent<string>) => {
      try {
        listener(decodeRestrictedAgentExecutionEvent(type, JSON.parse(event.data) as unknown))
      } catch {
        // 无效事件不改变本地状态，后续状态查询会校正。
      }
    }
    source.addEventListener(type, handler as EventListener)
    return { type, handler }
  })
  source.onerror = onDisconnect

  return () => {
    handlers.forEach(({ type, handler }) => source.removeEventListener(type, handler as EventListener))
    source.close()
  }
}

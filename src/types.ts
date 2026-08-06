// ===== 设置 =====

export type ApiMode = 'images' | 'responses'
export type BuiltInApiProvider = 'openai' | 'fal'
export type ApiProvider = BuiltInApiProvider | string
export type CustomProviderTemplate = 'http-image'

export type CustomProviderRequestMethod = 'GET' | 'POST'
export type CustomProviderContentType = 'json' | 'multipart'
export type CustomProviderFileSource = 'inputImages' | 'mask'

export interface CustomProviderFileMapping {
  field: string
  source: CustomProviderFileSource
  array?: boolean
}

export interface CustomProviderResultMapping {
  imageUrlPaths?: string[]
  b64JsonPaths?: string[]
}

export interface CustomProviderSubmitMapping {
  path: string
  method?: CustomProviderRequestMethod
  contentType?: CustomProviderContentType
  query?: Record<string, string>
  body?: Record<string, unknown>
  files?: CustomProviderFileMapping[]
  taskIdPath?: string
  result?: CustomProviderResultMapping
}

export interface CustomProviderPollMapping {
  path: string
  method?: CustomProviderRequestMethod
  query?: Record<string, string>
  intervalSeconds?: number
  statusPath: string
  successValues: string[]
  failureValues: string[]
  errorPath?: string
  result: CustomProviderResultMapping
}

export interface CustomProviderDefinition {
  id: string
  name: string
  template?: CustomProviderTemplate
  submit: CustomProviderSubmitMapping
  editSubmit?: CustomProviderSubmitMapping
  poll?: CustomProviderPollMapping
}

export interface ApiProfile {
  id: string
  name: string
  provider: ApiProvider
  baseUrl: string
  apiKey: string
  model: string
  timeout: number
  apiMode: ApiMode
  codexCli: boolean
  apiProxy: boolean
  responseFormatB64Json?: boolean
  providerDrafts?: Partial<Record<ApiProvider, Partial<Pick<ApiProfile, 'baseUrl' | 'model' | 'apiMode' | 'codexCli' | 'apiProxy' | 'responseFormatB64Json'>>>>
}

export interface AppSettings {
  /** 旧版单配置字段：保留用于导入/查询参数兼容，实际请求以 active profile 为准 */
  baseUrl: string
  apiKey: string
  model: string
  timeout: number
  apiMode: ApiMode
  codexCli: boolean
  apiProxy: boolean
  customProviders: CustomProviderDefinition[]
  providerOrder?: string[]
  clearInputAfterSubmit: boolean
  persistInputOnRestart: boolean
  reuseTaskApiProfileTemporarily: boolean
  alwaysShowRetryButton: boolean
  enterSubmit: boolean
  agentStreaming: boolean
  agentImageCount: number
  profiles: ApiProfile[]
  activeProfileId: string
}

// ===== 任务参数 =====

export interface TaskParams {
  size: string
  quality: 'auto' | 'low' | 'medium' | 'high'
  output_format: 'png' | 'jpeg' | 'webp'
  output_compression: number | null
  moderation: 'auto' | 'low'
  n: number
}

export const DEFAULT_PARAMS: TaskParams = {
  size: 'auto',
  quality: 'auto',
  output_format: 'png',
  output_compression: null,
  moderation: 'auto',
  n: 1,
}

// ===== 输入图片（UI 层面） =====

export interface InputImage {
  /** IndexedDB image store 的 id（SHA-256 hash） */
  id: string
  /** data URL，用于预览 */
  dataUrl: string
}

export interface MaskDraft {
  targetImageId: string
  maskDataUrl: string
  updatedAt: number
}

// ===== 任务记录 =====

export type TaskStatus = 'running' | 'done' | 'error'

export interface TaskRecord {
  id: string
  prompt: string
  params: TaskParams
  /** 生成时使用的 Provider 类型 */
  apiProvider?: ApiProvider
  /** 生成时使用的 API 配置 ID */
  apiProfileId?: string
  /** 生成时使用的 Provider 名称 */
  apiProfileName?: string
  /** 生成时使用的模型 ID */
  apiModel?: string
  /** fal.ai 队列请求 ID，用于连接断开后的结果恢复 */
  falRequestId?: string
  /** fal.ai 队列 endpoint，用于连接断开后的状态和结果查询 */
  falEndpoint?: string
  /** fal.ai 任务连接断开后是否等待自动恢复 */
  falRecoverable?: boolean
  /** 自定义异步服务商任务 ID，用于重启后继续查询结果 */
  customTaskId?: string
  /** 自定义异步任务是否等待自动恢复 */
  customRecoverable?: boolean
  /** API 返回的实际生效参数，用于标记与请求值不一致的情况 */
  actualParams?: Partial<TaskParams>
  /** 输出图片对应的实际生效参数，key 为 outputImages 中的图片 id */
  actualParamsByImage?: Record<string, Partial<TaskParams>>
  /** 输出图片对应的 API 改写提示词，key 为 outputImages 中的图片 id */
  revisedPromptByImage?: Record<string, string>
  /** 输入图片的 image store id 列表 */
  inputImageIds: string[]
  maskTargetImageId?: string | null
  maskImageId?: string | null
  /** 输出图片的 image store id 列表 */
  outputImages: string[]
  /** API 返回的原始图片 HTTP URL（非 base64 时记录） */
  rawImageUrls?: string[]
  /** 发生解析错误时的原始响应 JSON */
  rawResponsePayload?: string
  status: TaskStatus
  error: string | null
  createdAt: number
  finishedAt: number | null
  /** 总耗时毫秒 */
  elapsed: number | null
  /** 是否收藏 */
  isFavorite?: boolean
  /** 任务入口。旧任务未设置时按 gallery 处理。 */
  origin?: 'gallery' | 'agent' | 'restricted-agent' | 'openshop'
  /** 默认 Agent 对话的本地会话标识。旧记录未设置时按单独会话兼容。 */
  agentConversationId?: string
  /** 默认 Agent 对话中的轮次，从 1 开始。 */
  agentTurn?: number
  /** 默认 Agent 返回的最终文本，用于刷新后恢复会话摘要与上下文。 */
  agentAssistantText?: string
  /** OpenShop 编辑结果对应的源任务 ID。 */
  sourceTaskId?: string
  /** 受限 Agent 服务端计划 ID。 */
  agentPlanId?: string
  /** 受限 Agent 服务端执行 ID，用于刷新后恢复状态。 */
  agentExecutionId?: string
  /** 用户在规划阶段提交的原始需求。 */
  agentOriginalRequest?: string
  /** 用户实际确认的不可变计划快照。 */
  agentPlanSnapshot?: RestrictedAgentPlan
}

// ===== 受限 Agent Gateway =====

export type RestrictedAgentPlanStatus =
  | 'awaiting_confirmation'
  | 'queued'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'failed_unknown'
  | 'expired'

export type RestrictedAgentExecutionStatus =
  | 'queued'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'failed_unknown'

export interface RestrictedAgentPlanStep {
  title: string
  operation: 'generate' | 'edit'
}

export interface RestrictedAgentPlanGeneration {
  exactPrompt: string
  action: 'generate' | 'edit'
  size: string
  quality: TaskParams['quality']
  outputFormat: TaskParams['output_format']
  outputCompression: number | null
  imageCount: number
}

export interface RestrictedAgentPlanInput {
  assetId: string
  role: 'reference' | 'mask_target' | 'mask'
  sha256: string
  mimeType: string
  width: number
  height: number
}

export interface RestrictedAgentPlan {
  id: string
  version: number
  status: RestrictedAgentPlanStatus
  expiresAt: string
  originalRequest: string
  summary: string
  steps: RestrictedAgentPlanStep[]
  generation: RestrictedAgentPlanGeneration
  inputs: RestrictedAgentPlanInput[]
  assumptions: string[]
  warnings: string[]
  policyVersion: string
}

export interface RestrictedAgentOutputAsset {
  id: string
  url: string
  mimeType: string
  sha256: string
  width: number
  height: number
  byteSize: number
}

export interface RestrictedAgentExecution {
  id: string
  planId: string
  status: RestrictedAgentExecutionStatus
  cancelRequested: boolean
  error: { code: string; message: string } | null
  outputAssets: RestrictedAgentOutputAsset[]
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  updatedAt: string
}

export interface RestrictedAgentCapabilities {
  enabled: boolean
  csrfToken: string
  policyVersion?: string
  limits?: {
    maxReferenceImages?: number
    maxFileBytes?: number
    maxUploadBytes?: number
    maxImagePixels?: number
    maxOutputImages?: number
    planTtlSeconds?: number
    assetTtlSeconds?: number
    maxQueue?: number
    maxConcurrency?: number
    planRatePerMinute?: number
    executeRatePerMinute?: number
    imagesRatePerHour?: number
  }
  parameters?: {
    sizes: string[]
    qualities: TaskParams['quality'][]
    outputFormats: TaskParams['output_format'][]
  }
}

// ===== IndexedDB 存储的图片 =====

export interface StoredImage {
  id: string
  dataUrl: string
  /** 图片首次存储时间（ms） */
  createdAt?: number
  /** 图片来源：用户上传 / API 生成 / 遮罩 / OpenShop 编辑 */
  source?: 'upload' | 'generated' | 'mask' | 'openshop'
  /** 原图宽度 */
  width?: number
  /** 原图高度 */
  height?: number
}

export interface StoredImageThumbnail {
  id: string
  /** 列表缩略图，用于避免卡片页解码完整 4K 原图 */
  thumbnailDataUrl: string
  /** 原图宽度 */
  width?: number
  /** 原图高度 */
  height?: number
  /** 缩略图生成参数版本 */
  thumbnailVersion?: number
}

// ===== API 请求体 =====

export interface ImageGenerationRequest {
  model: string
  prompt: string
  size: string
  quality: string
  output_format: string
  moderation: string
  output_compression?: number
  n?: number
}

// ===== API 响应 =====

export interface ImageResponseItem {
  b64_json?: string
  url?: string
  revised_prompt?: string
  size?: string
  quality?: string
  output_format?: string
  output_compression?: number
  moderation?: string
}

export interface ImageApiResponse {
  data: ImageResponseItem[]
  size?: string
  quality?: string
  output_format?: string
  output_compression?: number
  moderation?: string
  n?: number
}

export interface ResponsesOutputItem {
  type?: string
  result?: string | {
    b64_json?: string
    image?: string
    data?: string
  }
  size?: string
  quality?: string
  output_format?: string
  output_compression?: number
  moderation?: string
  revised_prompt?: string
}

export interface ResponsesApiResponse {
  output?: ResponsesOutputItem[]
  tools?: Array<{
    type?: string
    size?: string
    quality?: string
    output_format?: string
    output_compression?: number
    moderation?: string
    n?: number
  }>
}

export interface FalImageFile {
  url?: string
  content_type?: string
  file_name?: string
  width?: number
  height?: number
  b64_json?: string
  base64?: string
  data?: string
}

export interface FalApiResponse {
  images?: FalImageFile[]
  image?: FalImageFile | string
  url?: string
  seed?: number
}

// ===== 导出数据 =====

/** ZIP manifest.json 格式 */
export interface ExportData {
  version: number
  exportedAt: string
  settings?: AppSettings
  tasks?: TaskRecord[]
  /** imageId → 图片信息 */
  imageFiles?: Record<string, {
    path: string
    createdAt?: number
    source?: 'upload' | 'generated' | 'mask' | 'openshop'
    width?: number
    height?: number
  }>
  /** imageId → 缩略图信息 */
  thumbnailFiles?: Record<string, {
    path: string
    width?: number
    height?: number
    thumbnailVersion?: number
  }>
}

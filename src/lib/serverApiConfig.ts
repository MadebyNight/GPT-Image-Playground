import type { ApiMode, ApiProfile, AppSettings } from '../types'
import { getActiveApiProfile } from './apiProfiles'

declare const __RUNTIME_CONFIG_REQUIRED__: boolean

export const SERVER_MANAGED_PROFILE_ID = 'server-managed-openai'
export const DEFAULT_SERVER_API_PROXY_PATH = '/api-proxy'
export const DEFAULT_RESTRICTED_AGENT_BASE_PATH = '/agent-api/v1'
export const SERVER_API_CONFIG_UNAVAILABLE_MESSAGE = '服务端 API 配置不可用，请联系部署管理员'

interface DisabledServerApiConfig {
  enabled: false
}

interface EnabledServerApiConfig {
  enabled: true
  provider: 'openai'
  model: string
  apiMode: 'images' | 'responses'
  modelOptions: string[]
  apiModeOptions: ApiMode[]
  allowCustomModel: boolean
  codexCli: boolean
  responseFormatB64Json: boolean
  timeoutSeconds: number
  proxyPath: string
}

interface RestrictedAgentRuntimeConfig {
  enabled: boolean
  basePath: string
  agentOnly: boolean
}

export interface PublicRuntimeConfig {
  version: 1
  serverApi: DisabledServerApiConfig | EnabledServerApiConfig
  restrictedAgent?: RestrictedAgentRuntimeConfig
}

export type RuntimeConfigState =
  | { status: 'loading' }
  | { status: 'ready'; config: PublicRuntimeConfig }
  | { status: 'error'; error: string }

export type ChatCapabilitySource = 'direct' | 'proxy' | 'none'
export type ChatCapabilityStatus =
  | 'usable'
  | 'images_only'
  | 'missing_credentials'
  | 'loading'
  | 'error'

export interface ChatCapabilities {
  /** 当前部署是否允许配置 Chat（Responses）能力。 */
  chatAllowed: boolean
  /** 当前选中的 API Profile 是否为 OpenAI-compatible Responses。 */
  chatConfigured: boolean
  /** 当前配置是否已经具备实际提交 Chat 请求所需的凭据或服务端代理。 */
  chatUsable: boolean
  /** Chat 请求实际使用浏览器直连、同源代理，或当前尚无可判断来源。 */
  source: ChatCapabilitySource
  /** 用于 UI 精确区分不可用原因。 */
  status: ChatCapabilityStatus
}

const TOP_LEVEL_KEYS = new Set(['version', 'serverApi', 'restrictedAgent'])
const RESTRICTED_AGENT_KEYS = new Set(['enabled', 'basePath', 'agentOnly'])
const SERVER_API_KEYS = new Set([
  'enabled',
  'provider',
  'model',
  'apiMode',
  'modelOptions',
  'apiModeOptions',
  'allowCustomModel',
  'codexCli',
  'responseFormatB64Json',
  'timeoutSeconds',
  'proxyPath',
])
const SAFE_PROXY_PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/

let runtimeState: RuntimeConfigState = { status: 'loading' }
const STATIC_RUNTIME_CONFIG: PublicRuntimeConfig = { version: 1, serverApi: { enabled: false } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertAllowedKeys(record: Record<string, unknown>, allowedKeys: Set<string>, label: string) {
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label} 包含不允许的字段`)
  }
}

function normalizeProxyPath(value: unknown): string {
  if (value === undefined) return DEFAULT_SERVER_API_PROXY_PATH
  if (typeof value !== 'string') throw new Error('serverApi.proxyPath 必须是字符串')

  const trimmed = value.trim()
  if (!trimmed || trimmed === '/') throw new Error('serverApi.proxyPath 不能为空或根路径')
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) {
    throw new Error('serverApi.proxyPath 必须是同源路径')
  }
  if (/[?#\\\s]/.test(trimmed)) throw new Error('serverApi.proxyPath 包含非法字符')

  const segments = trimmed.split('/').filter(Boolean)
  if (!segments.length) throw new Error('serverApi.proxyPath 不能为空')

  for (const segment of segments) {
    if (segment === '.' || segment === '..' || !SAFE_PROXY_PATH_SEGMENT.test(segment)) {
      throw new Error('serverApi.proxyPath 包含非法路径段')
    }
  }

  return `/${segments.join('/')}`
}

function normalizeRestrictedAgentConfig(value: unknown): RestrictedAgentRuntimeConfig | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('restrictedAgent 必须是对象')
  assertAllowedKeys(value, RESTRICTED_AGENT_KEYS, 'restrictedAgent')
  if (typeof value.enabled !== 'boolean') throw new Error('restrictedAgent.enabled 必须是布尔值')
  if (typeof value.agentOnly !== 'boolean') throw new Error('restrictedAgent.agentOnly 必须是布尔值')

  const basePath = value.basePath === undefined ? DEFAULT_RESTRICTED_AGENT_BASE_PATH : value.basePath
  if (typeof basePath !== 'string' || basePath.trim() !== DEFAULT_RESTRICTED_AGENT_BASE_PATH) {
    throw new Error(`restrictedAgent.basePath 必须是 ${DEFAULT_RESTRICTED_AGENT_BASE_PATH}`)
  }
  return {
    enabled: value.enabled,
    basePath: DEFAULT_RESTRICTED_AGENT_BASE_PATH,
    agentOnly: value.enabled ? value.agentOnly : false,
  }
}

function normalizeModelId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} 不能为空`)
  }
  const trimmed = value.trim()
  if (trimmed.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._~:/+@=-]*$/.test(trimmed)) {
    throw new Error(`${label} 格式无效`)
  }
  return trimmed
}

function isValidModelId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._~:/+@=-]{0,255}$/.test(value)
}

function uniqueItems<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function normalizeApiModeOptions(value: unknown, fallback: ApiMode): ApiMode[] {
  if (value === undefined) return [fallback]
  if (!Array.isArray(value) || !value.length) throw new Error('serverApi.apiModeOptions 必须是非空数组')

  const options = uniqueItems(value.map((item) => {
    if (item !== 'images' && item !== 'responses') {
      throw new Error('serverApi.apiModeOptions 只能包含 images 或 responses')
    }
    return item
  }))
  if (!options.includes(fallback)) options.unshift(fallback)
  return options
}

function normalizeModelOptions(value: unknown, fallback: string): string[] {
  if (value === undefined) return [fallback]
  if (!Array.isArray(value) || !value.length) throw new Error('serverApi.modelOptions 必须是非空数组')

  const options = uniqueItems(value.map((item) => normalizeModelId(item, 'serverApi.modelOptions')))
  if (!options.includes(fallback)) options.unshift(fallback)
  return options
}

function parsePublicRuntimeConfig(raw: unknown): PublicRuntimeConfig {
  if (!isRecord(raw)) throw new Error('运行时配置必须是对象')
  assertAllowedKeys(raw, TOP_LEVEL_KEYS, '运行时配置')
  if (raw.version !== 1) throw new Error('不支持的运行时配置版本')
  if (!isRecord(raw.serverApi)) throw new Error('serverApi 配置缺失')
  const restrictedAgent = normalizeRestrictedAgentConfig(raw.restrictedAgent)

  const serverApi = raw.serverApi
  assertAllowedKeys(serverApi, SERVER_API_KEYS, 'serverApi')
  if (typeof serverApi.enabled !== 'boolean') throw new Error('serverApi.enabled 必须是布尔值')
  if (serverApi.enabled && restrictedAgent?.enabled) {
    throw new Error('serverApi 与 restrictedAgent 不能同时启用')
  }
  if (!serverApi.enabled) {
    return { version: 1, serverApi: { enabled: false }, ...(restrictedAgent ? { restrictedAgent } : {}) }
  }

  if (serverApi.provider !== 'openai') throw new Error('serverApi.provider 必须是 openai')
  const model = normalizeModelId(serverApi.model, 'serverApi.model')
  if (serverApi.apiMode !== 'images' && serverApi.apiMode !== 'responses') {
    throw new Error('serverApi.apiMode 必须是 images 或 responses')
  }
  const apiMode = serverApi.apiMode
  const apiModeOptions = normalizeApiModeOptions(serverApi.apiModeOptions, apiMode)
  const modelOptions = normalizeModelOptions(serverApi.modelOptions, model)
  const allowCustomModel = serverApi.allowCustomModel === undefined ? true : serverApi.allowCustomModel
  if (typeof allowCustomModel !== 'boolean') throw new Error('serverApi.allowCustomModel 必须是布尔值')
  if (typeof serverApi.codexCli !== 'boolean') throw new Error('serverApi.codexCli 必须是布尔值')
  if (typeof serverApi.responseFormatB64Json !== 'boolean') {
    throw new Error('serverApi.responseFormatB64Json 必须是布尔值')
  }
  if (
    typeof serverApi.timeoutSeconds !== 'number'
    || !Number.isFinite(serverApi.timeoutSeconds)
    || serverApi.timeoutSeconds < 10
    || serverApi.timeoutSeconds > 600
  ) {
    throw new Error('serverApi.timeoutSeconds 必须在 10 到 600 之间')
  }

  return {
    version: 1,
    serverApi: {
      enabled: true,
      provider: 'openai',
      model,
      apiMode,
      apiModeOptions,
      modelOptions,
      allowCustomModel,
      codexCli: serverApi.codexCli,
      responseFormatB64Json: serverApi.responseFormatB64Json,
      timeoutSeconds: serverApi.timeoutSeconds,
      proxyPath: normalizeProxyPath(serverApi.proxyPath),
    },
    ...(restrictedAgent ? { restrictedAgent } : {}),
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function initializeRuntimeConfig(raw: unknown): RuntimeConfigState {
  try {
    runtimeState = { status: 'ready', config: parsePublicRuntimeConfig(raw) }
  } catch (error) {
    runtimeState = { status: 'error', error: getErrorMessage(error) }
  }
  return runtimeState
}

export async function loadRuntimeConfig(required = __RUNTIME_CONFIG_REQUIRED__): Promise<void> {
  runtimeState = { status: 'loading' }
  if (!required) {
    runtimeState = { status: 'ready', config: STATIC_RUNTIME_CONFIG }
    return
  }
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}runtime-config.json`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    initializeRuntimeConfig(await response.json())
  } catch (error) {
    runtimeState = { status: 'error', error: getErrorMessage(error) }
  }
}

export function getRuntimeConfigState(): RuntimeConfigState {
  return runtimeState
}

export function isServerApiConfigEnabled(): boolean {
  return runtimeState.status === 'ready' && runtimeState.config.serverApi.enabled
}

export function isServerApiConfigUsable(): boolean {
  return isServerApiConfigEnabled()
}

export function getChatCapabilities(settings: AppSettings): ChatCapabilities {
  if (runtimeState.status === 'loading') {
    return {
      chatAllowed: false,
      chatConfigured: false,
      chatUsable: false,
      source: 'none',
      status: 'loading',
    }
  }
  if (runtimeState.status === 'error') {
    return {
      chatAllowed: false,
      chatConfigured: false,
      chatUsable: false,
      source: 'none',
      status: 'error',
    }
  }

  if (runtimeState.config.serverApi.enabled) {
    const chatAllowed = runtimeState.config.serverApi.apiModeOptions.includes('responses')
    const profile = getServerManagedApiProfile(settings)
    const chatConfigured = Boolean(chatAllowed && profile?.provider === 'openai' && profile.apiMode === 'responses')
    return {
      chatAllowed,
      chatConfigured,
      chatUsable: chatConfigured,
      source: 'proxy',
      status: chatConfigured ? 'usable' : 'images_only',
    }
  }

  const profile = getActiveApiProfile(settings)
  const chatConfigured = profile.provider === 'openai' && profile.apiMode === 'responses'
  const chatUsable = chatConfigured && Boolean(profile.apiKey.trim())
  return {
    chatAllowed: true,
    chatConfigured,
    chatUsable,
    source: 'direct',
    status: chatUsable ? 'usable' : chatConfigured ? 'missing_credentials' : 'images_only',
  }
}

export function isRestrictedAgentEnabled(): boolean {
  return runtimeState.status === 'ready' && runtimeState.config.restrictedAgent?.enabled === true
}

export function isRestrictedAgentOnly(): boolean {
  return runtimeState.status === 'ready'
    && runtimeState.config.restrictedAgent?.enabled === true
    && runtimeState.config.restrictedAgent.agentOnly
}

export function getRestrictedAgentBasePath(): string {
  return runtimeState.status === 'ready'
    ? runtimeState.config.restrictedAgent?.basePath ?? DEFAULT_RESTRICTED_AGENT_BASE_PATH
    : DEFAULT_RESTRICTED_AGENT_BASE_PATH
}

export function getServerApiProxyPath(): string {
  return runtimeState.status === 'ready' && runtimeState.config.serverApi.enabled
    ? runtimeState.config.serverApi.proxyPath
    : DEFAULT_SERVER_API_PROXY_PATH
}

export function getServerManagedApiOptions(): { apiModeOptions: ApiMode[]; modelOptions: string[]; allowCustomModel: boolean } | null {
  if (runtimeState.status !== 'ready' || !runtimeState.config.serverApi.enabled) return null

  const config = runtimeState.config.serverApi
  return {
    apiModeOptions: config.apiModeOptions,
    modelOptions: config.modelOptions,
    allowCustomModel: config.allowCustomModel,
  }
}

function getSelectedManagedApiMode(settings: Partial<AppSettings> | undefined, config: EnabledServerApiConfig): ApiMode {
  const selected = settings?.apiMode
  return selected && config.apiModeOptions.includes(selected) ? selected : config.apiMode
}

function getSelectedManagedModel(settings: Partial<AppSettings> | undefined, config: EnabledServerApiConfig): string {
  const selected = typeof settings?.model === 'string' ? settings.model.trim() : ''
  if (selected && config.allowCustomModel && isValidModelId(selected)) return selected
  return selected && config.modelOptions.includes(selected) ? selected : config.model
}

export function getServerManagedApiProfile(settings?: Partial<AppSettings>): ApiProfile | null {
  if (runtimeState.status !== 'ready' || !runtimeState.config.serverApi.enabled) return null

  const config = runtimeState.config.serverApi
  const apiMode = getSelectedManagedApiMode(settings, config)
  const model = getSelectedManagedModel(settings, config)
  return {
    id: SERVER_MANAGED_PROFILE_ID,
    name: '服务端统一配置',
    provider: 'openai',
    baseUrl: `${config.proxyPath}/v1`,
    apiKey: '',
    model,
    timeout: config.timeoutSeconds,
    apiMode,
    codexCli: config.codexCli,
    apiProxy: true,
    responseFormatB64Json: config.responseFormatB64Json,
  }
}

export function getEffectiveApiProfile(settings: AppSettings): ApiProfile {
  if (runtimeState.status !== 'ready') throw new Error(SERVER_API_CONFIG_UNAVAILABLE_MESSAGE)
  return getServerManagedApiProfile(settings) ?? getActiveApiProfile(settings)
}

export function getEffectiveSettings(settings: AppSettings): AppSettings {
  if (runtimeState.status !== 'ready') throw new Error(SERVER_API_CONFIG_UNAVAILABLE_MESSAGE)
  const profile = getServerManagedApiProfile(settings)
  if (!profile) return settings

  return {
    ...settings,
    baseUrl: profile.baseUrl,
    apiKey: '',
    model: profile.model,
    timeout: profile.timeout,
    apiMode: profile.apiMode,
    codexCli: profile.codexCli,
    apiProxy: true,
    customProviders: [],
    providerOrder: ['openai'],
    reuseTaskApiProfileTemporarily: false,
    profiles: [profile],
    activeProfileId: profile.id,
  }
}

export function sanitizeSettingsPatchForServerMode(patch: Partial<AppSettings>): Partial<AppSettings> {
  if (runtimeState.status === 'ready' && !runtimeState.config.serverApi.enabled) return patch

  const sanitized: Partial<AppSettings> = {
    reuseTaskApiProfileTemporarily: false,
  }
  if (runtimeState.status === 'ready' && runtimeState.config.serverApi.enabled) {
    const config = runtimeState.config.serverApi
    if (patch.apiMode && config.apiModeOptions.includes(patch.apiMode)) sanitized.apiMode = patch.apiMode
    if (typeof patch.model === 'string') {
      const model = patch.model.trim()
      if (config.modelOptions.includes(model) || (config.allowCustomModel && isValidModelId(model))) sanitized.model = model
    }
  }
  if (typeof patch.clearInputAfterSubmit === 'boolean') sanitized.clearInputAfterSubmit = patch.clearInputAfterSubmit
  if (typeof patch.persistInputOnRestart === 'boolean') sanitized.persistInputOnRestart = patch.persistInputOnRestart
  if (typeof patch.alwaysShowRetryButton === 'boolean') sanitized.alwaysShowRetryButton = patch.alwaysShowRetryButton
  if (typeof patch.enterSubmit === 'boolean') sanitized.enterSubmit = patch.enterSubmit
  if (typeof patch.agentStreaming === 'boolean') sanitized.agentStreaming = patch.agentStreaming
  if (typeof patch.agentImageCount === 'number') sanitized.agentImageCount = patch.agentImageCount
  return sanitized
}

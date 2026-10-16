import type { ApiMode, ApiProfile } from '../types'
import { DEFAULT_IMAGES_MODEL, DEFAULT_RESPONSES_MODEL } from './apiProfiles'
import { buildApiUrl, normalizeBaseUrl } from './devProxy'
import { getServerApiProxyPath } from './serverApiConfig'

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:/+@=-]{0,255}$/
const MODELS_TIMEOUT_MS = 8000

export function resolveModelProtocol(model: string, mappings: Record<string, ApiMode> | null = null): ApiMode | null {
  if (mappings && Object.prototype.hasOwnProperty.call(mappings, model)) return mappings[model]
  if (model === DEFAULT_IMAGES_MODEL || /^(?:gpt-image|dall-e)(?:[-.]|$)/i.test(model)) return 'images'
  if (/image/i.test(model)) return null
  if (model === DEFAULT_RESPONSES_MODEL || /^gpt-(?:4|5|6)(?:[.-]|$)/i.test(model) || /^o[1-9](?:[.-]|$)/i.test(model)) return 'responses'
  return null
}

export type ModelAvailability =
  | { kind: 'available'; protocol: ApiMode }
  | { kind: 'protocol-unknown' }
  | { kind: 'no-image-generation' }

export function resolveModelAvailability(model: string, mappings: Record<string, ApiMode> | null = null): ModelAvailability {
  const protocol = resolveModelProtocol(model, mappings)
  if (protocol) return { kind: 'available', protocol }
  if (/^gemini(?:[.-].*)?[.-]image(?:[.-]|$)/i.test(model) || /^imagen/i.test(model)) {
    return { kind: 'protocol-unknown' }
  }
  return { kind: 'no-image-generation' }
}

export async function fetchAvailableModels(profile: ApiProfile, signal?: AbortSignal): Promise<string[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    if (!profile.apiProxy && !normalizeBaseUrl(profile.baseUrl)) throw new Error('当前 Profile 缺少 API URL')
    const url = profile.apiProxy
      ? `${getServerApiProxyPath()}/v1/models`
      : buildApiUrl(profile.baseUrl, 'models', null, false)
    const response = await fetch(url, {
      method: 'GET',
      headers: profile.apiProxy ? undefined : { Authorization: `Bearer ${profile.apiKey}` },
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`模型列表请求失败 (${response.status})`)
    const payload: unknown = await response.json()
    if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)) {
      throw new Error('模型列表格式无效')
    }
    const models = [...new Set(payload.data.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string') return []
      return MODEL_ID_PATTERN.test(entry.id) ? [entry.id] : []
    }))]
    if (!models.length) throw new Error('模型列表为空')
    return models
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

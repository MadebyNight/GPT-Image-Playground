import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from './apiProfiles'
import { fetchAvailableModels, resolveModelAvailability, resolveModelProtocol } from './modelCatalog'
import { initializeRuntimeConfig } from './serverApiConfig'

afterEach(() => {
  initializeRuntimeConfig({ version: 1, serverApi: { enabled: false } })
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('model protocol resolution', () => {
  it('prefers explicit deployment mapping over name rules and rejects unknown names', () => {
    expect(resolveModelProtocol('gpt-image-2', { 'gpt-image-2': 'responses' })).toBe('responses')
    expect(resolveModelProtocol('gpt-image-2')).toBe('images')
    expect(resolveModelProtocol('gpt-5.5')).toBe('responses')
    expect(resolveModelProtocol('gpt-5.5-image-experimental')).toBeNull()
    expect(resolveModelProtocol('vendor-unknown')).toBeNull()
  })

  it.each([
    ['gpt-image-2.5-sunburst', 'images'],
    ['dall-e-3', 'images'],
    ['gpt-5.6-luna', 'responses'],
    ['gpt-4.1', 'responses'],
    ['gpt-6.0', 'responses'],
    ['o1-preview', 'responses'],
    ['o9-pro', 'responses'],
  ] as const)('%s can generate images through %s', (model, protocol) => {
    expect(resolveModelAvailability(model)).toEqual({ kind: 'available', protocol })
  })

  it.each([
    'claude-sonnet-5-5', 'glm-5.3', 'kimi-k3', 'deepseek-v4.1-flash',
    'gemini-3.1-flash', 'vendor-unknown', 'gpt-5.6-image-experimental',
  ])('%s has no supported image generation capability', (model) => {
    expect(resolveModelAvailability(model)).toEqual({ kind: 'no-image-generation' })
  })

  it.each(['gemini-3.1-flash-image', 'imagen-4.0'])('%s needs an explicit compatibility protocol', (model) => {
    expect(resolveModelAvailability(model)).toEqual({ kind: 'protocol-unknown' })
    expect(resolveModelAvailability(model, { [model]: 'images' })).toEqual({ kind: 'available', protocol: 'images' })
  })

  it('lets an explicit deployment mapping override name-based capability', () => {
    expect(resolveModelAvailability('claude-sonnet-5-5', { 'claude-sonnet-5-5': 'responses' }))
      .toEqual({ kind: 'available', protocol: 'responses' })
    expect(resolveModelAvailability('gpt-image-2', { 'gpt-image-2': 'responses' }))
      .toEqual({ kind: 'available', protocol: 'responses' })
  })
})

describe('fetchAvailableModels', () => {
  it('fetches server models through the fixed same-origin proxy without a browser key', async () => {
    initializeRuntimeConfig({ version: 1, serverApi: {
      enabled: true, provider: 'openai', model: 'gpt-image-2', apiMode: 'images',
      modelOptions: ['gpt-image-2'], apiModeOptions: ['images', 'responses'],
      codexCli: false,
      responseFormatB64Json: false, timeoutSeconds: 600, proxyPath: '/api-proxy',
    } })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'gpt-image-2' }, { id: 'gpt-5.5' }] })))
    vi.stubGlobal('fetch', fetchMock)
    const profile = { ...DEFAULT_SETTINGS.profiles[0], apiProxy: true, apiKey: 'browser-secret' }

    expect(await fetchAvailableModels(profile)).toEqual(['gpt-image-2', 'gpt-5.5'])
    expect(fetchMock.mock.calls[0][0]).toBe('/api-proxy/v1/models')
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined()
  })

  it('uses the active personal profile URL and key, and rejects a failed response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'gpt-5.5' }] })))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const profile = { ...DEFAULT_SETTINGS.profiles[0], baseUrl: 'https://profile.example/v1', apiKey: 'profile-key', apiProxy: false }

    expect(await fetchAvailableModels(profile)).toEqual(['gpt-5.5'])
    expect(fetchMock.mock.calls[0][0]).toBe('https://profile.example/v1/models')
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer profile-key' })
    await expect(fetchAvailableModels(profile)).rejects.toThrow('503')
  })

  it('aborts a stalled upstream request and rejects an invalid list', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = fetchAvailableModels({ ...DEFAULT_SETTINGS.profiles[0], apiProxy: false })
    const rejected = expect(pending).rejects.toThrow('aborted')
    await vi.advanceTimersByTimeAsync(8000)
    await rejected
    vi.useRealTimers()

    fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ data: [{ model: 'missing-id' }] })))
    await expect(fetchAvailableModels({ ...DEFAULT_SETTINGS.profiles[0], apiProxy: false })).rejects.toThrow('模型列表为空')
  })
})

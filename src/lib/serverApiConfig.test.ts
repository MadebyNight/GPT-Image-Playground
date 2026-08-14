import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../types'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import {
  getAgentCapabilities,
  getAgentModePreference,
  getChatCapabilities,
  getChatUnavailableMessage,
  getEffectiveApiProfile,
  getEffectiveSettings,
  getRestrictedAgentBasePath,
  getRuntimeConfigState,
  getServerApiProxyPath,
  getServerManagedApiOptions,
  getServerManagedApiProfile,
  initializeRuntimeConfig,
  isRestrictedAgentEnabled,
  isRestrictedAgentOnly,
  isServerApiConfigEnabled,
  isServerApiConfigUsable,
  loadRuntimeConfig,
  markResponsesRuntimeAvailable,
  markResponsesRuntimeUnavailable,
  RESPONSES_RUNTIME_UNAVAILABLE_MESSAGE,
  resolveAgentMode,
  setAgentModePreference,
  sanitizeSettingsPatchForServerMode,
} from './serverApiConfig'

const enabledRuntimeConfig = {
  version: 1,
  serverApi: {
    enabled: true,
    provider: 'openai',
    model: 'gpt-image-2',
    apiMode: 'images',
    modelOptions: ['gpt-image-2'],
    apiModeOptions: ['images'],
    codexCli: false,
    responseFormatB64Json: false,
    timeoutSeconds: 600,
    proxyPath: '/api-proxy',
  },
} as const

const runtimeConfigUnavailableMessage = '服务端 API 配置不可用，请联系部署管理员'

function createClientSettingsWithCredentials(): AppSettings {
  const profile = {
    ...DEFAULT_SETTINGS.profiles[0],
    id: 'client-secret-profile',
    baseUrl: 'https://upstream.example/v1',
    apiKey: 'sk-client-secret',
    model: 'client-model',
  }
  return {
    ...DEFAULT_SETTINGS,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    profiles: [profile],
    activeProfileId: profile.id,
  }
}

afterEach(() => {
  initializeRuntimeConfig({ version: 1, serverApi: { enabled: false } })
  vi.unstubAllGlobals()
})

describe('initializeRuntimeConfig', () => {
  it('treats the disabled default as ready and preserves client behavior', () => {
    const state = initializeRuntimeConfig({ version: 1, serverApi: { enabled: false } })
    const patch = {
      model: 'client-model',
      enterSubmit: true,
      reuseTaskApiProfileTemporarily: true,
    }

    expect(state).toEqual({
      status: 'ready',
      config: { version: 1, serverApi: { enabled: false } },
    })
    expect(isServerApiConfigEnabled()).toBe(false)
    expect(isServerApiConfigUsable()).toBe(false)
    expect(getServerManagedApiProfile()).toBeNull()
    expect(getEffectiveApiProfile(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS.profiles[0])
    expect(getEffectiveSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettingsPatchForServerMode(patch)).toEqual(patch)
    expect(getChatCapabilities({
      ...DEFAULT_SETTINGS,
      apiMode: 'responses',
      apiKey: 'client-key',
      profiles: [{
        ...DEFAULT_SETTINGS.profiles[0],
        apiMode: 'responses',
        apiKey: 'client-key',
      }],
    })).toEqual({
      chatAllowed: true,
      chatConfigured: true,
      chatUsable: true,
      source: 'direct',
      status: 'usable',
    })
  })

  it('distinguishes local Chat permission, Responses configuration, and credentials', () => {
    const localResponses = {
      ...DEFAULT_SETTINGS,
      apiMode: 'responses' as const,
      apiKey: '',
      profiles: [{
        ...DEFAULT_SETTINGS.profiles[0],
        apiMode: 'responses' as const,
        apiKey: '',
      }],
    }

    expect(getChatCapabilities(localResponses)).toEqual({
      chatAllowed: true,
      chatConfigured: true,
      chatUsable: false,
      source: 'direct',
      status: 'missing_credentials',
    })
    expect(getChatCapabilities({
      ...localResponses,
      apiMode: 'images',
      profiles: [{ ...localResponses.profiles[0], apiMode: 'images' }],
    })).toEqual({
      chatAllowed: true,
      chatConfigured: false,
      chatUsable: false,
      source: 'direct',
      status: 'images_only',
    })
  })

  it('uses the final active profile when a task profile is reused temporarily', () => {
    const responsesProfile = createDefaultOpenAIProfile({
      id: 'responses-profile',
      apiMode: 'responses',
      apiKey: 'responses-key',
    })
    const imagesProfile = createDefaultOpenAIProfile({
      id: 'images-profile',
      apiMode: 'images',
      apiKey: 'images-key',
    })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      reuseTaskApiProfileTemporarily: true,
      profiles: [responsesProfile, imagesProfile],
      activeProfileId: responsesProfile.id,
    })

    const reusedImagesSettings = normalizeSettings({ ...settings, activeProfileId: imagesProfile.id })
    expect(getChatCapabilities(reusedImagesSettings)).toMatchObject({
      chatAllowed: true,
      chatConfigured: false,
      chatUsable: false,
      source: 'direct',
      status: 'images_only',
    })

    const globallyImages = normalizeSettings({ ...settings, activeProfileId: imagesProfile.id })
    const reusedResponsesSettings = normalizeSettings({ ...globallyImages, activeProfileId: responsesProfile.id })
    expect(getChatCapabilities(reusedResponsesSettings)).toMatchObject({
      chatAllowed: true,
      chatConfigured: true,
      chatUsable: true,
      source: 'direct',
      status: 'usable',
    })
  })

  it('uses managed Responses options to determine whether Chat is allowed and usable', () => {
    initializeRuntimeConfig({
      ...enabledRuntimeConfig,
      serverApi: {
        ...enabledRuntimeConfig.serverApi,
        apiMode: 'images',
        apiModeOptions: ['images', 'responses'],
      },
    })

    expect(getChatCapabilities(DEFAULT_SETTINGS)).toEqual({
      chatAllowed: true,
      chatConfigured: false,
      chatUsable: false,
      source: 'proxy',
      status: 'images_only',
    })
    expect(getChatCapabilities({ ...DEFAULT_SETTINGS, apiMode: 'responses' })).toEqual({
      chatAllowed: true,
      chatConfigured: true,
      chatUsable: true,
      source: 'proxy',
      status: 'usable',
    })

    initializeRuntimeConfig(enabledRuntimeConfig)
    expect(getChatCapabilities(DEFAULT_SETTINGS)).toEqual({
      chatAllowed: false,
      chatConfigured: false,
      chatUsable: false,
      source: 'proxy',
      status: 'images_only',
    })
  })

  it('distinguishes runtime loading from runtime errors', async () => {
    let release!: () => void
    const pending = new Promise<Response>((resolve) => {
      release = () => resolve(new Response('', { status: 500 }))
    })
    vi.stubGlobal('fetch', vi.fn(() => pending))

    const loading = loadRuntimeConfig(true)
    expect(getChatCapabilities(DEFAULT_SETTINGS)).toMatchObject({
      source: 'none',
      status: 'loading',
      chatUsable: false,
    })
    release()
    await loading
    expect(getChatCapabilities(DEFAULT_SETTINGS)).toMatchObject({
      source: 'none',
      status: 'error',
      chatUsable: false,
    })
  })

  it('builds a fixed managed profile without a browser credential', () => {
    initializeRuntimeConfig({
      ...enabledRuntimeConfig,
      serverApi: {
        ...enabledRuntimeConfig.serverApi,
        model: '  gpt-image-2  ',
        apiMode: 'responses',
        apiModeOptions: ['responses'],
        codexCli: true,
        responseFormatB64Json: true,
        timeoutSeconds: 120,
        proxyPath: ' api-proxy/// ',
      },
    })

    expect(getRuntimeConfigState()).toEqual({
      status: 'ready',
      config: {
        version: 1,
        serverApi: {
          enabled: true,
          provider: 'openai',
          model: 'gpt-image-2',
          apiMode: 'responses',
          modelOptions: ['gpt-image-2'],
          apiModeOptions: ['responses'],
          allowCustomModel: true,
          codexCli: true,
          responseFormatB64Json: true,
          timeoutSeconds: 120,
          proxyPath: '/api-proxy',
        },
      },
    })
    expect(isServerApiConfigEnabled()).toBe(true)
    expect(isServerApiConfigUsable()).toBe(true)
    expect(getServerApiProxyPath()).toBe('/api-proxy')
    expect(getServerManagedApiOptions()).toEqual({
      modelOptions: ['gpt-image-2'],
      apiModeOptions: ['responses'],
      allowCustomModel: true,
    })
    expect(getServerManagedApiProfile()).toEqual({
      id: 'server-managed-openai',
      name: '服务端统一配置',
      provider: 'openai',
      baseUrl: '/api-proxy/v1',
      apiKey: '',
      model: 'gpt-image-2',
      timeout: 120,
      apiMode: 'responses',
      codexCli: true,
      apiProxy: true,
      responseFormatB64Json: true,
    })
  })

  it('parses restricted Agent config while server API is disabled', () => {
    const state = initializeRuntimeConfig({
      version: 1,
      serverApi: { enabled: false },
      restrictedAgent: {
        enabled: true,
        basePath: '/agent-api/v1',
        agentOnly: true,
      },
    })

    expect(state).toEqual({
      status: 'ready',
      config: {
        version: 1,
        serverApi: { enabled: false },
        restrictedAgent: {
          enabled: true,
          basePath: '/agent-api/v1',
          agentOnly: true,
        },
      },
    })
    expect(isRestrictedAgentEnabled()).toBe(true)
    expect(isRestrictedAgentOnly()).toBe(true)
    expect(getRestrictedAgentBasePath()).toBe('/agent-api/v1')
  })

  it.each([
    { serverEnabled: false, agentEnabled: false, requestedAgentOnly: false, expectedStatus: 'ready', expectedAgentOnly: false },
    { serverEnabled: false, agentEnabled: false, requestedAgentOnly: true, expectedStatus: 'ready', expectedAgentOnly: false },
    { serverEnabled: false, agentEnabled: true, requestedAgentOnly: false, expectedStatus: 'ready', expectedAgentOnly: false },
    { serverEnabled: false, agentEnabled: true, requestedAgentOnly: true, expectedStatus: 'ready', expectedAgentOnly: true },
    { serverEnabled: true, agentEnabled: false, requestedAgentOnly: false, expectedStatus: 'ready', expectedAgentOnly: false },
    { serverEnabled: true, agentEnabled: false, requestedAgentOnly: true, expectedStatus: 'ready', expectedAgentOnly: false },
    { serverEnabled: true, agentEnabled: true, requestedAgentOnly: false, expectedStatus: 'ready', expectedAgentOnly: false },
    { serverEnabled: true, agentEnabled: true, requestedAgentOnly: true, expectedStatus: 'ready', expectedAgentOnly: true },
  ])(
    'normalizes dual-mode state: server=$serverEnabled agent=$agentEnabled agentOnly=$requestedAgentOnly',
    ({ serverEnabled, agentEnabled, requestedAgentOnly, expectedStatus, expectedAgentOnly }) => {
      const state = initializeRuntimeConfig({
        version: 1,
        serverApi: serverEnabled ? enabledRuntimeConfig.serverApi : { enabled: false },
        restrictedAgent: {
          enabled: agentEnabled,
          basePath: '/agent-api/v1',
          agentOnly: requestedAgentOnly,
        },
      })

      expect(state.status).toBe(expectedStatus)
      expect(isServerApiConfigEnabled()).toBe(expectedStatus === 'ready' && serverEnabled)
      expect(isRestrictedAgentEnabled()).toBe(expectedStatus === 'ready' && agentEnabled)
      expect(isRestrictedAgentOnly()).toBe(expectedAgentOnly)
      if (state.status === 'ready') {
        expect(state.config.restrictedAgent).toEqual({
          enabled: agentEnabled,
          basePath: '/agent-api/v1',
          agentOnly: expectedAgentOnly,
        })
      }
    },
  )

  it('以 Responses 可用性作为统一 Agent 总开关，并仅暴露 Tool Pipeline 状态', () => {
    initializeRuntimeConfig({
      ...enabledRuntimeConfig,
      serverApi: {
        ...enabledRuntimeConfig.serverApi,
        apiMode: 'responses',
        apiModeOptions: ['images', 'responses'],
      },
      restrictedAgent: {
        enabled: true,
        basePath: '/agent-api/v1',
        agentOnly: false,
      },
    })
    const dual = getAgentCapabilities({ ...DEFAULT_SETTINGS, apiMode: 'responses' })

    expect(dual).toMatchObject({
      agentUsable: true,
      responsesUsable: true,
      toolPipelineUsable: true,
      chatUsable: true,
      tool: true,
      defaultMode: 'chat',
      modeSwitching: false,
    })
    expect(resolveAgentMode(dual, 'tool')).toBe('chat')
    expect(resolveAgentMode(dual, 'invalid')).toBe('chat')

    initializeRuntimeConfig({
      version: 1,
      serverApi: { enabled: false },
      restrictedAgent: {
        enabled: true,
        basePath: '/agent-api/v1',
        agentOnly: false,
      },
    })
    const toolOnly = getAgentCapabilities(DEFAULT_SETTINGS)
    expect(toolOnly).toMatchObject({
      agentUsable: false,
      responsesUsable: false,
      toolPipelineUsable: true,
      chatUsable: false,
      tool: true,
      defaultMode: null,
      modeSwitching: false,
    })
    expect(resolveAgentMode(toolOnly, 'tool')).toBeNull()

    initializeRuntimeConfig({ version: 1, serverApi: { enabled: false } })
    const unavailable = getAgentCapabilities(DEFAULT_SETTINGS)
    expect(unavailable).toMatchObject({
      agentUsable: false,
      responsesUsable: false,
      toolPipelineUsable: false,
      chatUsable: false,
      tool: false,
      defaultMode: null,
      modeSwitching: false,
    })
    expect(resolveAgentMode(unavailable, 'tool')).toBeNull()
  })

  it('将当前页面的 Responses 运行时失败纳入统一 Agent 总开关，成功或重新加载配置后恢复', () => {
    const runtimeConfig = {
      ...enabledRuntimeConfig,
      serverApi: {
        ...enabledRuntimeConfig.serverApi,
        apiMode: 'responses' as const,
        apiModeOptions: ['responses'] as const,
      },
      restrictedAgent: {
        enabled: true,
        basePath: '/agent-api/v1',
        agentOnly: false,
      },
    }
    const settings: AppSettings = { ...DEFAULT_SETTINGS, apiMode: 'responses' }

    initializeRuntimeConfig(runtimeConfig)
    expect(getAgentCapabilities(settings)).toMatchObject({
      agentUsable: true,
      responsesUsable: true,
      toolPipelineUsable: true,
    })

    markResponsesRuntimeUnavailable()
    expect(getAgentCapabilities(settings)).toMatchObject({
      agentUsable: false,
      responsesUsable: false,
      toolPipelineUsable: true,
      chatUsable: false,
    })
    expect(getChatUnavailableMessage(settings)).toBe(RESPONSES_RUNTIME_UNAVAILABLE_MESSAGE)

    markResponsesRuntimeAvailable()
    expect(getAgentCapabilities(settings).responsesUsable).toBe(true)

    markResponsesRuntimeUnavailable()
    initializeRuntimeConfig(runtimeConfig)
    expect(getAgentCapabilities(settings).responsesUsable).toBe(true)
  })

  it('不再读取或写入 Chat/Tool 偏好，避免它参与路由决策', () => {
    const storage = {
      value: null as string | null,
      getItem: vi.fn(() => storage.value),
      setItem: vi.fn((_key: string, value: string) => { storage.value = value }),
    }

    expect(getAgentModePreference(storage)).toBeNull()
    setAgentModePreference('tool', storage)
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(getAgentModePreference(storage)).toBeNull()
  })

  it('旧偏好兼容入口不会访问 browser localStorage', () => {
    const restrictedWindow = {}
    Object.defineProperty(restrictedWindow, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError')
      },
    })
    vi.stubGlobal('window', restrictedWindow)

    expect(getAgentModePreference()).toBeNull()
    expect(() => setAgentModePreference('tool')).not.toThrow()
  })

  it('uses deployment-provided API mode options and allows safe custom models by default', () => {
    initializeRuntimeConfig({
      ...enabledRuntimeConfig,
      serverApi: {
        ...enabledRuntimeConfig.serverApi,
        model: 'gpt-image-2',
        apiMode: 'images',
        modelOptions: ['gpt-image-2', 'gpt-5.5'],
        apiModeOptions: ['images', 'responses'],
      },
    })

    const selectedSettings: AppSettings = {
      ...DEFAULT_SETTINGS,
      model: 'gpt-5.5',
      apiMode: 'responses',
    }
    expect(getServerManagedApiOptions()).toEqual({
      modelOptions: ['gpt-image-2', 'gpt-5.5'],
      apiModeOptions: ['images', 'responses'],
      allowCustomModel: true,
    })
    expect(getServerManagedApiProfile(selectedSettings)).toMatchObject({
      model: 'gpt-5.5',
      apiMode: 'responses',
      baseUrl: '/api-proxy/v1',
      apiKey: '',
    })
    expect(getEffectiveSettings(selectedSettings)).toMatchObject({
      model: 'gpt-5.5',
      apiMode: 'responses',
      baseUrl: '/api-proxy/v1',
      apiKey: '',
    })

    const forbiddenSettings: AppSettings = {
      ...DEFAULT_SETTINGS,
      model: 'forbidden-model',
      apiMode: 'responses',
    }
    expect(getServerManagedApiProfile(forbiddenSettings)).toMatchObject({
      model: 'forbidden-model',
      apiMode: 'responses',
    })
  })

  it('falls back to configured model options when custom model input is disabled', () => {
    initializeRuntimeConfig({
      ...enabledRuntimeConfig,
      serverApi: {
        ...enabledRuntimeConfig.serverApi,
        modelOptions: ['gpt-image-2', 'gpt-5.5'],
        allowCustomModel: false,
      },
    })

    expect(getServerManagedApiOptions()).toEqual({
      modelOptions: ['gpt-image-2', 'gpt-5.5'],
      apiModeOptions: ['images'],
      allowCustomModel: false,
    })
    expect(getServerManagedApiProfile({ ...DEFAULT_SETTINGS, model: 'custom-model' })).toMatchObject({
      model: 'gpt-image-2',
    })
    expect(getServerManagedApiProfile({ ...DEFAULT_SETTINGS, model: 'gpt-5.5' })).toMatchObject({
      model: 'gpt-5.5',
    })
  })

  it('uses the default same-origin proxy path when it is omitted', () => {
    const { proxyPath: _proxyPath, ...serverApi } = enabledRuntimeConfig.serverApi

    initializeRuntimeConfig({ version: 1, serverApi })

    expect(getServerApiProxyPath()).toBe('/api-proxy')
    expect(getServerManagedApiProfile()?.baseUrl).toBe('/api-proxy/v1')
  })

  it('keeps general preferences and custom model while removing fixed API configuration', () => {
    initializeRuntimeConfig(enabledRuntimeConfig)
    const clientSettings: AppSettings = {
      ...DEFAULT_SETTINGS,
      baseUrl: 'https://upstream.example/v1',
      apiKey: 'browser-secret',
      model: 'client-model',
      clearInputAfterSubmit: true,
      persistInputOnRestart: false,
      reuseTaskApiProfileTemporarily: true,
      alwaysShowRetryButton: true,
      enterSubmit: true,
      providerOrder: ['custom-example', 'fal', 'openai'],
      customProviders: [{
        id: 'custom-example',
        name: 'Custom Example',
        submit: { path: 'images/generations' },
      }],
      profiles: [{
        ...DEFAULT_SETTINGS.profiles[0],
        id: 'client-profile',
        name: 'Client Profile',
        baseUrl: 'https://upstream.example/v1',
        apiKey: 'browser-secret',
        model: 'client-model',
      }],
      activeProfileId: 'client-profile',
    }

    const effective = getEffectiveSettings(clientSettings)

    expect(effective).toMatchObject({
      clearInputAfterSubmit: true,
      persistInputOnRestart: false,
      reuseTaskApiProfileTemporarily: false,
      alwaysShowRetryButton: true,
      enterSubmit: true,
      baseUrl: '/api-proxy/v1',
      apiKey: '',
      model: 'client-model',
      timeout: 600,
      apiMode: 'images',
      codexCli: false,
      apiProxy: true,
      activeProfileId: 'server-managed-openai',
    })
    expect(effective.customProviders).toEqual([])
    expect(effective.providerOrder).toEqual(['openai'])
    expect(effective.profiles).toEqual([getServerManagedApiProfile(clientSettings)])
    expect(JSON.stringify(effective)).not.toContain('browser-secret')
    expect(JSON.stringify(effective)).not.toContain('upstream.example')
  })

  it('throws instead of returning client credentials when runtime configuration is invalid', () => {
    const clientSettings = createClientSettingsWithCredentials()
    initializeRuntimeConfig(null)

    expect(() => getEffectiveApiProfile(clientSettings)).toThrow(runtimeConfigUnavailableMessage)
    expect(() => getEffectiveSettings(clientSettings)).toThrow(runtimeConfigUnavailableMessage)
  })

  it('fails closed for missing, malformed, unsafe, or out-of-range enabled data', () => {
    const invalidInputs: unknown[] = [
      null,
      {},
      { version: 2, serverApi: { enabled: false } },
      { version: 1 },
      { version: 1, serverApi: { enabled: 'true' } },
      { version: 1, serverApi: { enabled: true } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, provider: 'fal' } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, model: '   ' } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, modelOptions: [] } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, modelOptions: ['gpt-image-2', 'bad model'] } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, apiMode: 'chat' } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, apiModeOptions: [] } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, apiModeOptions: ['images', 'chat'] } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, allowCustomModel: 'true' } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, codexCli: 0 } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, responseFormatB64Json: 'false' } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, timeoutSeconds: 9 } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, timeoutSeconds: 601 } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, timeoutSeconds: Number.NaN } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, proxyPath: 'https://evil.example/api' } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, proxyPath: '//evil.example/api' } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, proxyPath: '/../api-proxy' } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, proxyPath: '/api-proxy?target=evil' } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, proxyPath: '/api-proxy/%41' } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, proxyPath: '/api-proxy/%252e%252e' } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, proxyPath: '/api-proxy/\u0000admin' } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, proxyPath: '/api-proxy/admin:debug' } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, proxyPath: '/api-proxy/admin@host' } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, proxyPath: '/api-proxy/管理员' } },
      { ...enabledRuntimeConfig, serverApi: { ...enabledRuntimeConfig.serverApi, apiKey: 'must-not-be-public' } },
      { ...enabledRuntimeConfig, upstreamUrl: 'https://upstream.example' },
      { version: 1, serverApi: { enabled: false }, restrictedAgent: true },
      { version: 1, serverApi: { enabled: false }, restrictedAgent: { enabled: 'true', basePath: '/agent-api/v1', agentOnly: true } },
      { version: 1, serverApi: { enabled: false }, restrictedAgent: { enabled: true, basePath: '/other', agentOnly: true } },
      { version: 1, serverApi: { enabled: false }, restrictedAgent: { enabled: true, basePath: '/agent-api/v1', agentOnly: true, apiKey: 'secret' } },
    ]

    for (const input of invalidInputs) {
      const state = initializeRuntimeConfig(input)
      expect(state.status, JSON.stringify(input)).toBe('error')
      expect(isServerApiConfigEnabled()).toBe(false)
      expect(isServerApiConfigUsable()).toBe(false)
      expect(getServerManagedApiProfile()).toBeNull()
      expect(getServerApiProxyPath()).toBe('/api-proxy')
    }
  })
})

describe('sanitizeSettingsPatchForServerMode', () => {
  it('allows only general preferences and forces temporary profile reuse off', () => {
    initializeRuntimeConfig(enabledRuntimeConfig)
    const patch: Partial<AppSettings> = {
      clearInputAfterSubmit: true,
      persistInputOnRestart: false,
      reuseTaskApiProfileTemporarily: true,
      alwaysShowRetryButton: true,
      enterSubmit: true,
      baseUrl: 'https://upstream.example/v1',
      apiKey: 'browser-secret',
      model: 'client-model',
      profiles: DEFAULT_SETTINGS.profiles,
      customProviders: [],
      activeProfileId: DEFAULT_SETTINGS.activeProfileId,
    }

    expect(sanitizeSettingsPatchForServerMode(patch)).toEqual({
      clearInputAfterSubmit: true,
      persistInputOnRestart: false,
      alwaysShowRetryButton: true,
      enterSubmit: true,
      model: 'client-model',
      reuseTaskApiProfileTemporarily: false,
    })
  })

  it('allows listed API mode and safe custom model values in managed mode patches by default', () => {
    initializeRuntimeConfig({
      ...enabledRuntimeConfig,
      serverApi: {
        ...enabledRuntimeConfig.serverApi,
        modelOptions: ['gpt-image-2', 'gpt-5.5'],
        apiModeOptions: ['images', 'responses'],
      },
    })

    expect(sanitizeSettingsPatchForServerMode({
      model: 'gpt-5.5',
      apiMode: 'responses',
      baseUrl: 'https://upstream.example/v1',
      apiKey: 'browser-secret',
    })).toEqual({
      model: 'gpt-5.5',
      apiMode: 'responses',
      reuseTaskApiProfileTemporarily: false,
    })

    expect(sanitizeSettingsPatchForServerMode({
      model: 'custom-model',
      apiMode: 'responses',
    })).toEqual({
      model: 'custom-model',
      apiMode: 'responses',
      reuseTaskApiProfileTemporarily: false,
    })
  })

  it('filters custom model patches when custom model input is disabled', () => {
    initializeRuntimeConfig({
      ...enabledRuntimeConfig,
      serverApi: {
        ...enabledRuntimeConfig.serverApi,
        modelOptions: ['gpt-image-2', 'gpt-5.5'],
        allowCustomModel: false,
      },
    })

    expect(sanitizeSettingsPatchForServerMode({
      model: 'custom-model',
      apiMode: 'images',
    })).toEqual({
      apiMode: 'images',
      reuseTaskApiProfileTemporarily: false,
    })

    expect(sanitizeSettingsPatchForServerMode({
      model: 'gpt-5.5',
    })).toEqual({
      model: 'gpt-5.5',
      reuseTaskApiProfileTemporarily: false,
    })
  })

  it('also filters patches while runtime configuration is unavailable', () => {
    initializeRuntimeConfig(null)

    expect(sanitizeSettingsPatchForServerMode({
      apiKey: 'browser-secret',
      enterSubmit: true,
    })).toEqual({
      enterSubmit: true,
      reuseTaskApiProfileTemporarily: false,
    })
  })
})

describe('loadRuntimeConfig', () => {
  it('skips runtime-config fetch and restores Legacy client settings for static builds', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const clientSettings = createClientSettingsWithCredentials()

    await loadRuntimeConfig(false)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(getRuntimeConfigState()).toEqual({
      status: 'ready',
      config: { version: 1, serverApi: { enabled: false } },
    })
    expect(getEffectiveApiProfile(clientSettings)).toEqual(clientSettings.profiles[0])
    expect(getEffectiveSettings(clientSettings)).toEqual(clientSettings)
  })

  it('throws instead of returning client credentials while runtime configuration is loading', async () => {
    let resolveResponse!: (value: unknown) => void
    const responsePromise = new Promise((resolve) => {
      resolveResponse = resolve
    })
    vi.stubGlobal('fetch', vi.fn(() => responsePromise))
    const loadPromise = loadRuntimeConfig()
    const clientSettings = createClientSettingsWithCredentials()

    try {
      expect(getRuntimeConfigState()).toEqual({ status: 'loading' })
      expect(() => getEffectiveApiProfile(clientSettings)).toThrow(runtimeConfigUnavailableMessage)
      expect(() => getEffectiveSettings(clientSettings)).toThrow(runtimeConfigUnavailableMessage)
    } finally {
      resolveResponse({
        ok: true,
        json: vi.fn().mockResolvedValue({ version: 1, serverApi: { enabled: false } }),
      })
      await loadPromise
    }
  })

  it('loads with no-store caching and initializes the singleton', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(enabledRuntimeConfig),
    })
    vi.stubGlobal('fetch', fetchMock)

    await loadRuntimeConfig()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toMatch(/runtime-config\.json$/)
    expect(fetchMock.mock.calls[0][1]).toEqual({ cache: 'no-store' })
    expect(isServerApiConfigUsable()).toBe(true)
  })

  it('keeps runtime deployments fail-closed when runtime-config returns 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))

    await loadRuntimeConfig(true)

    expect(getRuntimeConfigState()).toEqual({ status: 'error', error: 'HTTP 404' })
    expect(() => getEffectiveApiProfile(createClientSettingsWithCredentials())).toThrow(runtimeConfigUnavailableMessage)
    expect(isServerApiConfigUsable()).toBe(false)
  })

  it('keeps runtime deployments fail-closed when runtime-config schema is invalid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ version: 0, serverApi: { enabled: false } }),
    }))

    await loadRuntimeConfig(true)

    expect(getRuntimeConfigState()).toEqual({ status: 'error', error: '不支持的运行时配置版本' })
    expect(() => getEffectiveSettings(createClientSettingsWithCredentials())).toThrow(runtimeConfigUnavailableMessage)
    expect(isServerApiConfigUsable()).toBe(false)
  })
})

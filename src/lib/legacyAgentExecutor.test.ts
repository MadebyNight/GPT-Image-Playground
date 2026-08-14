import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type AppSettings, type TaskRecord } from '../types'
import { DEFAULT_SETTINGS } from './apiProfiles'
import {
  getAgentCapabilities,
  getChatUnavailableMessage,
  getEffectiveSettings,
  initializeRuntimeConfig,
  RESPONSES_RUNTIME_UNAVAILABLE_MESSAGE,
} from './serverApiConfig'
import {
  LEGACY_AGENT_ASSISTANT_TEXT,
  LEGACY_AGENT_COMPLETED_RESPONSE,
  LEGACY_AGENT_IMAGE_BASE64,
  LEGACY_AGENT_PROMPT,
  LEGACY_AGENT_REQUEST_BODY_FIXTURE,
  createLegacyAgentSseFixture,
} from '../test/fixtures/legacyAgentResponses'
import type { CallApiOptions, CallApiResult } from './imageApiShared'

type SubmitTaskMockOptions = {
  onTaskCreated?: (taskId: string) => void
  callApi?: (opts: CallApiOptions) => Promise<CallApiResult>
  taskMetadata?: {
    origin: 'agent'
    agentConversationId: string
    agentTurn: number
  }
  draftSnapshot?: unknown
}

const storeMock = vi.hoisted(() => {
  const state = {
    prompt: '',
    inputImages: [] as Array<{ id: string; dataUrl: string }>,
    tasks: [] as TaskRecord[],
    setPrompt: vi.fn(),
    setParams: vi.fn(),
    showToast: vi.fn(),
    setShowSettings: vi.fn(),
    settings: undefined as unknown as AppSettings,
    composerVersion: 0,
    maskDraft: null,
    reusedTaskApiProfileId: null,
    reusedTaskApiProfileName: null,
    reusedTaskApiProfileMissing: false,
  }
  return {
    state,
    submitTask: vi.fn<(options?: SubmitTaskMockOptions) => Promise<string | null>>(),
    retryTaskWithExecution: vi.fn(),
  }
})

function createResponsesSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    apiMode: 'responses',
    apiKey: 'test-key',
    profiles: [{ ...DEFAULT_SETTINGS.profiles[0], apiMode: 'responses', apiKey: 'test-key' }],
  }
}

vi.mock('../store', () => ({
  submitTask: storeMock.submitTask,
  retryTaskWithExecution: storeMock.retryTaskWithExecution,
  useStore: {
    getState: () => storeMock.state,
  },
}))

import { callAgentResponsesImageApi, cancelAgentTask, retryAgentTask, storeBackedAgentExecutor, subscribeAgentProgress } from './legacyAgentExecutor'

describe('storeBackedAgentExecutor', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    storeMock.state.inputImages = []
    storeMock.state.prompt = ''
    storeMock.state.tasks = []
    storeMock.state.setPrompt.mockClear()
    storeMock.state.setParams.mockClear()
    storeMock.state.showToast.mockClear()
    storeMock.state.setShowSettings.mockClear()
    storeMock.state.composerVersion = 0
    storeMock.state.maskDraft = null
    storeMock.state.reusedTaskApiProfileId = null
    storeMock.state.reusedTaskApiProfileName = null
    storeMock.state.reusedTaskApiProfileMissing = false
    storeMock.state.settings = {
      ...DEFAULT_SETTINGS,
      apiMode: 'responses',
      apiKey: 'test-key',
      profiles: [{ ...DEFAULT_SETTINGS.profiles[0], apiMode: 'responses', apiKey: 'test-key' }],
    }
    storeMock.submitTask.mockReset()
    storeMock.retryTaskWithExecution.mockReset()
    initializeRuntimeConfig({ version: 1, serverApi: { enabled: false } })
  })

  it('delegates to submitTask and returns the created task id', async () => {
    storeMock.state.inputImages = [{ id: 'image-a', dataUrl: 'data:image/png;base64,a' }]
    storeMock.state.prompt = '生成海报'
    storeMock.submitTask.mockImplementation(async (options) => {
      options?.onTaskCreated?.('task-1')
      return 'task-1'
    })

    const result = await storeBackedAgentExecutor.submit({
      prompt: '生成海报',
      inputImageIds: ['image-a'],
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
      stream: true,
      imageCount: 2,
    })

    expect(result).toBe('task-1')
    expect(storeMock.state.setPrompt).not.toHaveBeenCalled()
    expect(storeMock.state.setParams).not.toHaveBeenCalled()
    expect(storeMock.submitTask).toHaveBeenCalledTimes(1)
    expect(storeMock.submitTask.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      callApi: expect.any(Function),
      onTaskCreated: expect.any(Function),
      taskMetadata: expect.objectContaining({
        origin: 'agent',
        agentConversationId: expect.stringMatching(/^agent-/),
        agentTurn: 1,
      }),
      draftSnapshot: expect.objectContaining({
        prompt: '生成海报',
        inputImages: storeMock.state.inputImages,
        params: { ...DEFAULT_PARAMS, size: '1024x1024', n: 2 },
        composerVersion: 0,
      }),
    }))
  })

  it('rejects requests that do not match current input images', async () => {
    storeMock.state.inputImages = [{ id: 'image-a', dataUrl: 'data:image/png;base64,a' }]

    const result = await storeBackedAgentExecutor.submit({
      prompt: '生成海报',
      inputImageIds: ['other-image'],
      params: { ...DEFAULT_PARAMS },
      stream: false,
      imageCount: 1,
    })

    expect(result).toBeNull()
    expect(storeMock.submitTask).not.toHaveBeenCalled()
    expect(storeMock.state.showToast).toHaveBeenCalledWith('Agent 请求与当前输入图片不一致，未提交任务', 'error')
  })

  it('matches the submitted draft after prompt whitespace normalization', async () => {
    storeMock.state.prompt = '生成海报  \n'
    storeMock.state.composerVersion = 7
    storeMock.submitTask.mockResolvedValue('task-normalized-prompt')

    await storeBackedAgentExecutor.submit({
      prompt: '生成海报',
      inputImageIds: [],
      params: { ...DEFAULT_PARAMS },
      stream: true,
      imageCount: 1,
    })

    expect(storeMock.submitTask.mock.calls[0]?.[0]?.draftSnapshot).toEqual(expect.objectContaining({
      prompt: '生成海报',
      composerVersion: 7,
    }))
  })

  it('calls Responses API without the prompt rewrite guard in agent mode', async () => {
    initializeRuntimeConfig({
      version: 1,
      serverApi: { enabled: false },
      restrictedAgent: {
        enabled: true,
        basePath: '/agent-api/v1',
        agentOnly: false,
      },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(LEGACY_AGENT_COMPLETED_RESPONSE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callAgentResponsesImageApi({
      settings: {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        model: 'gpt-5.5',
        timeout: 60,
        apiMode: 'responses',
        codexCli: false,
        apiProxy: false,
        customProviders: [],
        providerOrder: undefined,
        clearInputAfterSubmit: false,
        persistInputOnRestart: true,
        reuseTaskApiProfileTemporarily: false,
        alwaysShowRetryButton: false,
        enterSubmit: false,
        agentStreaming: false,
        agentImageCount: 1,
        profiles: [{
          id: 'default-openai',
          name: '默认',
          provider: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'gpt-5.5',
          timeout: 60,
          apiMode: 'responses',
          codexCli: false,
          apiProxy: false,
        }],
        activeProfileId: 'default-openai',
      },
      prompt: LEGACY_AGENT_PROMPT,
      params: { ...DEFAULT_PARAMS, n: 1 },
      inputImageDataUrls: [],
    }, { stream: false, imageCount: 1 })

    expect(result.images).toHaveLength(1)
    expect(result.assistantText).toBe(LEGACY_AGENT_ASSISTANT_TEXT)
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.input).toBe(LEGACY_AGENT_PROMPT)
    expect(body.input).not.toContain('Do not rewrite it')
    expect(body.tools[0]).toMatchObject({ type: 'image_generation', action: 'generate' })
    expect(body.tool_choice).toBe('required')
    expect(body.stream).toBeUndefined()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.com/v1/responses')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    })
  })

  it('在 BYOK 直连 Responses 路径保留既有历史上下文拼接', async () => {
    initializeRuntimeConfig({ version: 1, serverApi: { enabled: false } })
    const conversationContext = '上一轮已按 870×220 px 交付横幅，保留深蓝夜景。'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(LEGACY_AGENT_COMPLETED_RESPONSE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callAgentResponsesImageApi({
      settings: storeMock.state.settings,
      prompt: LEGACY_AGENT_PROMPT,
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
      agentConversationContext: conversationContext,
    }, { stream: false, imageCount: 1 })

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.input).toBe(`${conversationContext}\n\n本轮请求：\n${LEGACY_AGENT_PROMPT}`)
    expect(body).not.toHaveProperty('conversationContext')
  })

  it.each([
    ['严格尺寸', '生成一张 870×220 px 的夏日咖啡横幅', '检测到严格输出或确定性编辑要求：精确尺寸 870×220px。'],
    ['未绑定历史图片', '编辑上一张图', '历史图片尚未显式绑定'],
    ['不支持格式', '导出 GIF 格式', 'GIF 不是当前严格图片工具链支持的输出格式。'],
  ])('在发起请求前阻断%s回合，并保留路由原因', async (_label, prompt, reason) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch 不应被调用'))

    await expect(callAgentResponsesImageApi({
      settings: storeMock.state.settings,
      prompt,
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: false, imageCount: 1 })).rejects.toThrow(reason)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(getAgentCapabilities(storeMock.state.settings).responsesUsable).toBe(true)
  })

  it('uses the same-origin Gateway proxy contract without browser credentials', async () => {
    initializeRuntimeConfig({
      version: 1,
      serverApi: {
        enabled: true,
        provider: 'openai',
        model: 'gpt-5.5',
        apiMode: 'responses',
        modelOptions: ['gpt-5.5'],
        apiModeOptions: ['responses'],
        codexCli: false,
        responseFormatB64Json: false,
        timeoutSeconds: 60,
        proxyPath: '/gateway-proxy',
      },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(LEGACY_AGENT_COMPLETED_RESPONSE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callAgentResponsesImageApi({
      settings: getEffectiveSettings(DEFAULT_SETTINGS),
      prompt: LEGACY_AGENT_PROMPT,
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: false, imageCount: 1 })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/gateway-proxy/responses')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ 'Content-Type': 'application/json' })
  })

  it('Gateway capabilities 不可达时保留服务端同源 Responses 代理', async () => {
    initializeRuntimeConfig({
      version: 1,
      serverApi: {
        enabled: true,
        provider: 'openai',
        model: 'gpt-5.5',
        apiMode: 'responses',
        modelOptions: ['gpt-5.5'],
        apiModeOptions: ['responses'],
        codexCli: false,
        responseFormatB64Json: false,
        timeoutSeconds: 60,
        proxyPath: '/gateway-proxy',
      },
      restrictedAgent: {
        enabled: true,
        basePath: '/agent-api/v1',
        agentOnly: false,
      },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Gateway 不可达'))
      .mockResolvedValueOnce(new Response(JSON.stringify(LEGACY_AGENT_COMPLETED_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    await callAgentResponsesImageApi({
      settings: getEffectiveSettings(DEFAULT_SETTINGS),
      prompt: LEGACY_AGENT_PROMPT,
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: false, imageCount: 1 })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/agent-api/v1/capabilities')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/gateway-proxy/responses')
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ 'Content-Type': 'application/json' })
  })

  it('取消 Gateway capabilities 探测时不回退到直连 Responses', async () => {
    initializeRuntimeConfig({
      version: 1,
      serverApi: {
        enabled: true,
        provider: 'openai',
        model: 'gpt-5.5',
        apiMode: 'responses',
        modelOptions: ['gpt-5.5'],
        apiModeOptions: ['responses'],
        codexCli: false,
        responseFormatB64Json: false,
        timeoutSeconds: 60,
        proxyPath: '/gateway-proxy',
      },
      restrictedAgent: {
        enabled: true,
        basePath: '/agent-api/v1',
        agentOnly: false,
      },
    })
    let capabilitySignal: AbortSignal | undefined
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      capabilitySignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        capabilitySignal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
    })

    const request = callAgentResponsesImageApi({
      settings: getEffectiveSettings(DEFAULT_SETTINGS),
      prompt: LEGACY_AGENT_PROMPT,
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: false, imageCount: 1, taskId: 'cancel-capabilities-probe' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/agent-api/v1/capabilities')
    expect(capabilitySignal).toBeInstanceOf(AbortSignal)
    expect(cancelAgentTask('cancel-capabilities-probe')).toBe(true)
    await expect(request).rejects.toMatchObject({ message: 'Agent 请求已取消' })
    expect(capabilitySignal?.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('服务端托管 Responses 且 Gateway 可达时走受控 relay，并保持 SSE 解析', async () => {
    initializeRuntimeConfig({
      version: 1,
      serverApi: {
        enabled: true,
        provider: 'openai',
        model: 'gpt-5.5',
        apiMode: 'responses',
        modelOptions: ['gpt-5.5'],
        apiModeOptions: ['responses'],
        codexCli: false,
        responseFormatB64Json: false,
        timeoutSeconds: 60,
        proxyPath: '/gateway-proxy',
      },
      restrictedAgent: {
        enabled: true,
        basePath: '/agent-api/v1',
        agentOnly: false,
      },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { enabled: true, csrfToken: 'relay-csrf-token' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(createLegacyAgentSseFixture(), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      }))

    const conversationContext = '上一轮已严格输出 870×220 px 的横幅；本轮无需沿用该规格。'

    const result = await callAgentResponsesImageApi({
      settings: getEffectiveSettings(DEFAULT_SETTINGS),
      prompt: LEGACY_AGENT_PROMPT,
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
      agentConversationContext: conversationContext,
    }, { stream: true, imageCount: 1, taskId: 'gateway-relay-stream' })

    expect(result.images).toEqual([`data:image/png;base64,${LEGACY_AGENT_IMAGE_BASE64}`])
    expect(result.assistantText).toBe(LEGACY_AGENT_ASSISTANT_TEXT)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/agent-api/v1/capabilities')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/agent-api/v1/responses/image')
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'relay-csrf-token',
    })
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      request: LEGACY_AGENT_PROMPT,
      input: LEGACY_AGENT_PROMPT,
      conversationContext,
      stream: true,
      imageTool: {
        type: 'image_generation',
        action: 'generate',
        size: DEFAULT_PARAMS.size,
        quality: DEFAULT_PARAMS.quality,
        output_format: DEFAULT_PARAMS.output_format,
      },
    })
  })

  it('Relay POST 断连不会打开 Responses breaker', async () => {
    initializeRuntimeConfig({
      version: 1,
      serverApi: {
        enabled: true,
        provider: 'openai',
        model: 'gpt-5.5',
        apiMode: 'responses',
        modelOptions: ['gpt-5.5'],
        apiModeOptions: ['responses'],
        codexCli: false,
        responseFormatB64Json: false,
        timeoutSeconds: 60,
        proxyPath: '/gateway-proxy',
      },
      restrictedAgent: {
        enabled: true,
        basePath: '/agent-api/v1',
        agentOnly: false,
      },
    })
    const settings = getEffectiveSettings(DEFAULT_SETTINGS)
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { enabled: true, csrfToken: 'relay-csrf-token' },
      }), { status: 200 }))
      .mockRejectedValueOnce(new TypeError('Relay 连接中断'))

    await expect(callAgentResponsesImageApi({
      settings,
      prompt: LEGACY_AGENT_PROMPT,
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: false, imageCount: 1 })).rejects.toThrow('Relay 连接中断')

    expect(getAgentCapabilities(settings).responsesUsable).toBe(true)
  })

  it('固定 Chat Responses 请求体与流事件契约', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(createLegacyAgentSseFixture(), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    const events: Array<{ type: string; text?: string; status?: string; image?: string; assistantText?: string }> = []
    const unsubscribe = subscribeAgentProgress((event) => events.push(event))

    try {
      const result = await callAgentResponsesImageApi({
        settings: {
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'gpt-5.5',
          timeout: 60,
          apiMode: 'responses',
          codexCli: false,
          apiProxy: false,
          customProviders: [],
          providerOrder: undefined,
          clearInputAfterSubmit: false,
          persistInputOnRestart: true,
          reuseTaskApiProfileTemporarily: false,
          alwaysShowRetryButton: false,
          enterSubmit: false,
          agentStreaming: true,
          agentImageCount: 1,
          profiles: [{
            id: 'default-openai',
            name: '默认',
            provider: 'openai',
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'test-key',
            model: 'gpt-5.5',
            timeout: 60,
            apiMode: 'responses',
            codexCli: false,
            apiProxy: false,
          }],
          activeProfileId: 'default-openai',
        },
        prompt: LEGACY_AGENT_PROMPT,
        params: { ...DEFAULT_PARAMS },
        inputImageDataUrls: [],
      }, { stream: true, imageCount: 1, taskId: 'task-stream' })

      expect(result.images).toEqual([`data:image/png;base64,${LEGACY_AGENT_IMAGE_BASE64}`])
      expect(result.assistantText).toBe(LEGACY_AGENT_ASSISTANT_TEXT)
    } finally {
      unsubscribe()
    }

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(LEGACY_AGENT_REQUEST_BODY_FIXTURE)
    expect(events.filter((event) => event.type === 'assistant_delta').map((event) => event.text)).toEqual([
      'Chromium ',
      '基线已完成。',
    ])
    expect(events.filter((event) => event.type === 'tool_status').map((event) => event.status)).toEqual([
      'queued',
      'in_progress',
      'completed',
    ])
    expect(events).toContainEqual(expect.objectContaining({
      type: 'partial_image',
      image: `data:image/png;base64,${LEGACY_AGENT_IMAGE_BASE64}`,
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'done',
      assistantText: LEGACY_AGENT_ASSISTANT_TEXT,
    }))
  })

  it('将同一会话的有限文本上下文写入下一次 Responses 请求', async () => {
    const settings: AppSettings = {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      model: 'gpt-5.5',
      timeout: 60,
      apiMode: 'responses',
      codexCli: false,
      apiProxy: false,
      customProviders: [],
      providerOrder: undefined,
      clearInputAfterSubmit: false,
      persistInputOnRestart: true,
      reuseTaskApiProfileTemporarily: false,
      alwaysShowRetryButton: false,
      enterSubmit: false,
      agentStreaming: false,
      agentImageCount: 1,
      profiles: [{
        id: 'default-openai',
        name: '默认',
        provider: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        model: 'gpt-5.5',
        timeout: 60,
        apiMode: 'responses',
        codexCli: false,
        apiProxy: false,
      }],
      activeProfileId: 'default-openai',
    }
    storeMock.state.tasks = [
      {
        id: 'turn-1',
        prompt: '把画面改成蓝色基调',
        params: { ...DEFAULT_PARAMS },
        inputImageIds: [],
        outputImages: ['image-turn-1'],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
        elapsed: 1,
        origin: 'agent',
        agentConversationId: 'conversation-a',
        agentTurn: 1,
        agentAssistantText: '已保留原构图，并将主色调整为蓝色。',
      },
      {
        id: 'unrelated-turn',
        prompt: '不应进入当前对话的内容',
        params: { ...DEFAULT_PARAMS },
        inputImageIds: [],
        outputImages: ['image-other'],
        status: 'done',
        error: null,
        createdAt: 2,
        finishedAt: 3,
        elapsed: 1,
        origin: 'agent',
        agentConversationId: 'conversation-b',
        agentTurn: 1,
        agentAssistantText: '不应进入当前对话的回复',
      },
    ]
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: '已完成标题更新。' }] },
        { type: 'image_generation_call', result: 'aW1hZ2U=' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    storeMock.submitTask.mockImplementation(async (options) => {
      options?.onTaskCreated?.('turn-2')
      await options?.callApi?.({
        settings,
        prompt: '把标题改为夏日新品',
        params: { ...DEFAULT_PARAMS, n: 1 },
        inputImageDataUrls: [],
      })
      return 'turn-2'
    })

    const events: Array<{ type: string; assistantText?: string }> = []
    const unsubscribe = subscribeAgentProgress((event) => events.push(event))
    try {
      await storeBackedAgentExecutor.submit({
        prompt: '把标题改为夏日新品',
        inputImageIds: [],
        params: { ...DEFAULT_PARAMS },
        stream: false,
        imageCount: 1,
        conversationId: 'conversation-a',
      })
    } finally {
      unsubscribe()
    }

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.input).toEqual(expect.any(String))
    expect(body.input).toContain('把画面改成蓝色基调')
    expect(body.input).toContain('已保留原构图，并将主色调整为蓝色。')
    expect(body.input).toMatch(/本轮请求：\s*把标题改为夏日新品/)
    expect(body.input).not.toContain('不应进入当前对话的内容')
    expect(body.input).not.toContain('不应进入当前对话的回复')
    expect(storeMock.submitTask.mock.calls[0]?.[0]?.taskMetadata).toEqual({
      origin: 'agent',
      agentConversationId: 'conversation-a',
      agentTurn: 2,
    })
    expect(events).toContainEqual(expect.objectContaining({ type: 'done', assistantText: '已完成标题更新。' }))
  })

  it('serializes rapid submissions in one conversation and allocates distinct turns', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    storeMock.submitTask.mockImplementation(async (options) => {
      if (options?.taskMetadata?.agentTurn === 1) await firstGate
      const taskId = `turn-${options?.taskMetadata?.agentTurn}`
      const metadata = options?.taskMetadata
      if (metadata) {
        storeMock.state.tasks = [{
          id: taskId,
          prompt: '并发请求',
          params: { ...DEFAULT_PARAMS },
          inputImageIds: [],
          outputImages: [],
          status: 'running',
          error: null,
          createdAt: metadata.agentTurn,
          finishedAt: null,
          elapsed: null,
          ...metadata,
        }, ...storeMock.state.tasks]
      }
      options?.onTaskCreated?.(taskId)
      return taskId
    })

    const first = storeBackedAgentExecutor.submit({
      prompt: '第一条', inputImageIds: [], params: { ...DEFAULT_PARAMS }, stream: true, imageCount: 1, conversationId: 'conversation-lock',
    })
    const second = storeBackedAgentExecutor.submit({
      prompt: '第二条', inputImageIds: [], params: { ...DEFAULT_PARAMS }, stream: true, imageCount: 1, conversationId: 'conversation-lock',
    })
    await vi.waitFor(() => expect(storeMock.submitTask).toHaveBeenCalledTimes(1))
    releaseFirst()
    await Promise.all([first, second])

    expect(storeMock.submitTask.mock.calls.map((call) => call[0]?.taskMetadata?.agentTurn)).toEqual([1, 2])
  })

  it('preserves non-empty assistant partial text when an SSE stream fails', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"已生成一部分"}\n\n'))
        setTimeout(() => controller.error(new Error('流连接中断')), 0)
      },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    await expect(callAgentResponsesImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiMode: 'responses',
        apiKey: 'test-key',
        profiles: [{ ...DEFAULT_SETTINGS.profiles[0], apiMode: 'responses', apiKey: 'test-key' }],
      },
      prompt: '测试失败 partial',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: true, imageCount: 1, taskId: 'partial-error-task' })).rejects.toMatchObject({
      message: '流连接中断',
      agentAssistantText: '已生成一部分',
    })
  })

  it('rejects HTTP errors without manufacturing assistant partial text', async () => {
    const settings = createResponsesSettings()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: '上游拒绝请求' },
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callAgentResponsesImageApi({
      settings,
      prompt: '测试 HTTP 错误',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: true, imageCount: 1, taskId: 'http-error-task' })).rejects.toMatchObject({
      message: '上游拒绝请求',
    })
    expect(getAgentCapabilities(settings).responsesUsable).toBe(true)
  })

  it('不把用户 400 视为 Responses 服务故障', async () => {
    const settings = createResponsesSettings()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: '请求参数无效' },
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callAgentResponsesImageApi({
      settings,
      prompt: LEGACY_AGENT_PROMPT,
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: false, imageCount: 1 })).rejects.toThrow('请求参数无效')
    expect(getAgentCapabilities(settings).responsesUsable).toBe(true)
  })

  it.each([502, 504])('在 Responses HTTP %i 后熔断 Agent，并由随后成功的普通请求恢复', async (status) => {
    const settings = createResponsesSettings()
    initializeRuntimeConfig({
      version: 1,
      serverApi: { enabled: false },
      restrictedAgent: {
        enabled: true,
        basePath: '/agent-api/v1',
        agentOnly: false,
      },
    })
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: `上游 ${status}` } }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(LEGACY_AGENT_COMPLETED_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    await expect(callAgentResponsesImageApi({
      settings,
      prompt: LEGACY_AGENT_PROMPT,
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: false, imageCount: 1, taskId: `runtime-${status}` })).rejects.toThrow(`上游 ${status}`)

    expect(getAgentCapabilities(settings)).toMatchObject({
      agentUsable: false,
      responsesUsable: false,
      toolPipelineUsable: true,
    })
    expect(getChatUnavailableMessage(settings)).toBe(RESPONSES_RUNTIME_UNAVAILABLE_MESSAGE)

    const failedTask: TaskRecord = {
      id: `failed-runtime-${status}`,
      prompt: LEGACY_AGENT_PROMPT,
      params: { ...DEFAULT_PARAMS },
      inputImageIds: [],
      outputImages: [],
      status: 'error',
      error: `上游 ${status}`,
      createdAt: 1,
      finishedAt: 2,
      elapsed: 1,
      origin: 'agent',
      agentConversationId: `runtime-${status}`,
      agentTurn: 1,
    }
    expect(await retryAgentTask(failedTask)).toBeNull()
    expect(storeMock.retryTaskWithExecution).not.toHaveBeenCalled()

    await expect(callAgentResponsesImageApi({
      settings,
      prompt: LEGACY_AGENT_PROMPT,
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: false, imageCount: 1, taskId: `runtime-recover-${status}` })).resolves.toMatchObject({
      images: [expect.any(String)],
    })
    expect(getAgentCapabilities(settings).responsesUsable).toBe(true)
  })

  it('在实际 Responses 网络失败后打开 breaker', async () => {
    const settings = createResponsesSettings()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('网络不可达'))

    await expect(callAgentResponsesImageApi({
      settings,
      prompt: LEGACY_AGENT_PROMPT,
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: false, imageCount: 1 })).rejects.toThrow('网络不可达')
    expect(getAgentCapabilities(settings).responsesUsable).toBe(false)
  })

  it('只对服务端托管 Responses 的凭据失败打开 breaker，不把用户 4xx 当作服务故障', async () => {
    initializeRuntimeConfig({
      version: 1,
      serverApi: {
        enabled: true,
        provider: 'openai',
        model: 'gpt-5.5',
        apiMode: 'responses',
        modelOptions: ['gpt-5.5'],
        apiModeOptions: ['responses'],
        codexCli: false,
        responseFormatB64Json: false,
        timeoutSeconds: 60,
        proxyPath: '/gateway-proxy',
      },
    })
    const managedSettings = getEffectiveSettings(DEFAULT_SETTINGS)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: '服务端 API Key 无效' },
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(callAgentResponsesImageApi({
      settings: managedSettings,
      prompt: LEGACY_AGENT_PROMPT,
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: false, imageCount: 1 })).rejects.toThrow('服务端 API Key 无效')
    expect(getAgentCapabilities(managedSettings).responsesUsable).toBe(false)

    initializeRuntimeConfig({ version: 1, serverApi: { enabled: false } })
    const userSettings = createResponsesSettings()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: { message: '用户 API Key 无效' },
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }))
    await expect(callAgentResponsesImageApi({
      settings: userSettings,
      prompt: LEGACY_AGENT_PROMPT,
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: false, imageCount: 1 })).rejects.toThrow('用户 API Key 无效')
    expect(getAgentCapabilities(userSettings).responsesUsable).toBe(true)
  })

  it('uses response.failed terminal details and persists preceding partial text', async () => {
    const body = [
      'data: {"type":"response.output_text.delta","delta":"失败前 partial"}\n\n',
      'data: {"type":"response.failed","response":{"error":{"message":"模型执行失败"}}}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    await expect(callAgentResponsesImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiMode: 'responses',
        apiKey: 'test-key',
        profiles: [{ ...DEFAULT_SETTINGS.profiles[0], apiMode: 'responses', apiKey: 'test-key' }],
      },
      prompt: '测试 response.failed',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: true, imageCount: 1, taskId: 'response-failed-task' })).rejects.toMatchObject({
      message: '模型执行失败',
      agentAssistantText: '失败前 partial',
    })
  })

  it('cancels an open SSE reader immediately after response.failed', async () => {
    let readerCancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'data: {"type":"response.output_text.delta","delta":"失败前 partial"}\n\n',
          'data: {"type":"response.failed","response":{"error":{"message":"保持连接时失败"}}}\n\n',
        ].join('')))
      },
      cancel() {
        readerCancelled = true
      },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    const request = callAgentResponsesImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiMode: 'responses',
        apiKey: 'test-key',
        profiles: [{ ...DEFAULT_SETTINGS.profiles[0], apiMode: 'responses', apiKey: 'test-key' }],
      },
      prompt: '测试保持连接的 response.failed',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: true, imageCount: 1, taskId: 'open-response-failed-task' })

    await expect(Promise.race([
      request,
      new Promise((_, reject) => setTimeout(() => reject(new Error('请求仍在等待 EOF')), 100)),
    ])).rejects.toMatchObject({
      message: '保持连接时失败',
      agentAssistantText: '失败前 partial',
    })
    expect(readerCancelled).toBe(true)
  })

  it('cancels an open SSE reader immediately after an error event', async () => {
    let readerCancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"error","message":"流事件错误"}\n\n'))
      },
      cancel() {
        readerCancelled = true
      },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    await expect(callAgentResponsesImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiMode: 'responses',
        apiKey: 'test-key',
        profiles: [{ ...DEFAULT_SETTINGS.profiles[0], apiMode: 'responses', apiKey: 'test-key' }],
      },
      prompt: '测试 error event',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: true, imageCount: 1, taskId: 'open-error-event-task' })).rejects.toThrow('流事件错误')
    expect(readerCancelled).toBe(true)
  })

  it('persists partial text when the SSE stream reaches EOF without response.completed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'data: {"type":"response.output_text.delta","delta":"EOF 前 partial"}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))

    await expect(callAgentResponsesImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiMode: 'responses',
        apiKey: 'test-key',
        profiles: [{ ...DEFAULT_SETTINGS.profiles[0], apiMode: 'responses', apiKey: 'test-key' }],
      },
      prompt: '测试 EOF',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: true, imageCount: 1, taskId: 'eof-task' })).rejects.toMatchObject({
      message: '流式响应结束但没有返回完整结果',
      agentAssistantText: 'EOF 前 partial',
    })
  })

  it('retains completed earlier text plus the failing image partial in a multi-image request', async () => {
    const secondBody = [
      'data: {"type":"response.output_text.delta","delta":"第二张 partial"}\n\n',
      'data: {"type":"response.failed","response":{"error":{"message":"第二张失败"}}}\n\n',
    ].join('')
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(createLegacyAgentSseFixture(), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }))
      .mockResolvedValueOnce(new Response(secondBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }))

    await expect(callAgentResponsesImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiMode: 'responses',
        apiKey: 'test-key',
        profiles: [{ ...DEFAULT_SETTINGS.profiles[0], apiMode: 'responses', apiKey: 'test-key' }],
      },
      prompt: '测试多图部分失败',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, { stream: true, imageCount: 2, taskId: 'multi-partial-task' })).rejects.toMatchObject({
      message: '第二张失败',
      agentAssistantText: `${LEGACY_AGENT_ASSISTANT_TEXT}\n第二张 partial`,
    })
  })

  it('cancels an active stream and retains the emitted assistant partial', async () => {
    const settings = createResponsesSettings()
    let partialSeen!: () => void
    const sawPartial = new Promise<void>((resolve) => { partialSeen = resolve })
    const unsubscribe = subscribeAgentProgress((event) => {
      if (event.type === 'assistant_delta') partialSeen()
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"取消前 partial"}\n\n'))
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
        },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    })

    try {
      const request = callAgentResponsesImageApi({
        settings,
        prompt: '测试取消',
        params: { ...DEFAULT_PARAMS },
        inputImageDataUrls: [],
      }, { stream: true, imageCount: 1, taskId: 'cancel-task' })
      await sawPartial

      expect(cancelAgentTask('cancel-task')).toBe(true)
      await expect(request).rejects.toMatchObject({
        message: 'Agent 请求已取消',
        agentAssistantText: '取消前 partial',
      })
      expect(getAgentCapabilities(settings).responsesUsable).toBe(true)
    } finally {
      unsubscribe()
    }
  })

  it('retries through the Responses Agent path while preserving the conversation', async () => {
    const failedTask: TaskRecord = {
      id: 'failed-agent-task',
      prompt: '重试这一轮',
      params: { ...DEFAULT_PARAMS },
      inputImageIds: [],
      outputImages: [],
      status: 'error',
      error: '失败',
      createdAt: 1,
      finishedAt: 2,
      elapsed: 1,
      origin: 'agent',
      agentConversationId: 'conversation-retry',
      agentTurn: 1,
      agentAssistantText: '未完成 partial',
    }
    storeMock.state.tasks = [failedTask]
    storeMock.state.inputImages = []
    storeMock.state.tasks = [failedTask]
    storeMock.state.settings = { ...storeMock.state.settings, agentStreaming: false }
    storeMock.retryTaskWithExecution.mockImplementation(async (_task, options) => {
      options.onTaskCreated?.('retry-task')
      await options.callApi({
        settings: {
          ...DEFAULT_SETTINGS,
          apiMode: 'responses',
          apiKey: 'test-key',
          profiles: [{ ...DEFAULT_SETTINGS.profiles[0], apiMode: 'responses', apiKey: 'test-key' }],
        },
        prompt: failedTask.prompt,
        params: { ...DEFAULT_PARAMS },
        inputImageDataUrls: [],
      })
      return 'retry-task'
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(LEGACY_AGENT_COMPLETED_RESPONSE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    expect(await retryAgentTask(failedTask)).toBe('retry-task')
    expect(storeMock.retryTaskWithExecution).toHaveBeenCalledWith(failedTask, expect.objectContaining({
      callApi: expect.any(Function),
      onTaskCreated: expect.any(Function),
      taskMetadata: {
        origin: 'agent',
        agentConversationId: 'conversation-retry',
        agentTurn: 2,
      },
    }))
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))
    expect(body.tool_choice).toBe('required')
    expect(body.tools).toEqual([expect.objectContaining({ type: 'image_generation' })])
    expect(String(body.input)).not.toContain('未完成 partial')
  })
})

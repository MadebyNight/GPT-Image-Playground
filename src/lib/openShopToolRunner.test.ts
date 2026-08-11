import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type TaskRecord } from '../types'
import type { OpenShopToolResponseMessage } from './openshopBridge'
import {
  OpenShopToolBridgeClient,
  OpenShopToolRunnerError,
  openShopToolRunner,
  type OpenShopToolRunnerDependencies,
  type OpenShopToolSaveContext,
} from './openShopToolRunner'

interface FakeMessageHost {
  host: Window
  emit: (data: unknown, source?: Window, origin?: string) => void
  listenerCount: () => number
}

function createMessageHost(frameWindow: Window, targetOrigin: string): FakeMessageHost {
  const listeners = new Set<EventListener>()
  const host = {
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      if (type === 'message') listeners.add(listener)
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      if (type === 'message') listeners.delete(listener)
    }),
  } as unknown as Window
  return {
    host,
    emit(data, source = frameWindow, origin = targetOrigin) {
      const event = { data, source, origin } as MessageEvent
      for (const listener of [...listeners]) listener(event)
    },
    listenerCount: () => listeners.size,
  }
}

function task(id = 'openshop-output-task'): TaskRecord {
  return {
    id,
    prompt: 'tool output',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: ['source-image'],
    outputImages: ['output-image'],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 1,
    elapsed: 0,
    origin: 'openshop',
    sourceTaskId: 'source-task',
  }
}

function toolBase(id: unknown, sessionId: unknown) {
  return { version: 1, id, requestId: id, sessionId }
}

function readyMessage(id: unknown, sessionId: unknown) {
  return {
    ...toolBase(id, sessionId),
    type: 'openshop:tool:ready',
    capabilities: {
      commands: ['canvas.crop', 'canvas.rotate', 'canvas.flip', 'canvas.flatten'],
      maxCommands: 5,
      inputMimeTypes: ['image/png'],
      outputFormats: ['png'],
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

interface RunnerHarness {
  dependencies: OpenShopToolRunnerDependencies
  frame: HTMLIFrameElement
  frameListeners: Map<string, Set<EventListener>>
  messageListeners: Map<string, Set<EventListener>>
  postedTypes: string[]
  outputBlob: Blob
}

function createRunnerHarness(options: {
  loadInput?: OpenShopToolRunnerDependencies['loadInput']
  saveOutput?: OpenShopToolRunnerDependencies['saveOutput']
  appendError?: Error
  inputBlob?: Blob
} = {}): RunnerHarness {
  const targetOrigin = 'https://example.test'
  const messageListeners = new Map<string, Set<EventListener>>()
  const frameListeners = new Map<string, Set<EventListener>>()
  const postedTypes: string[] = []
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
  const inputBlob = options.inputBlob ?? new Blob([pngBytes], { type: 'image/png' })
  const outputBlob = new Blob([pngBytes], { type: 'image/png' })
  const descriptorBefore = { canvas: { width: 3, height: 2 }, primaryImage: { present: true } }
  const descriptorAfter = { canvas: { width: 2, height: 2 }, primaryImage: { present: true } }

  const emit = (data: unknown) => {
    const event = { data, source: frameWindow, origin: targetOrigin } as MessageEvent
    for (const listener of messageListeners.get('message') ?? []) listener(event)
  }
  const frameWindow = {
    postMessage: vi.fn((message: Record<string, unknown>) => {
      postedTypes.push(String(message.type))
      const base = toolBase(message.id, message.sessionId)
      queueMicrotask(() => {
        if (message.type === 'openshop:tool:hello') {
          emit(readyMessage(message.id, message.sessionId))
        } else if (message.type === 'openshop:tool:configure') {
          emit({ ...base, type: 'openshop:tool:configured', document: descriptorBefore })
        } else if (message.type === 'openshop:tool:execute') {
          emit({
            ...base,
            type: 'openshop:tool:executed',
            appliedCommands: 1,
            changed: true,
            document: descriptorAfter,
          })
        } else if (message.type === 'openshop:tool:export') {
          emit({
            ...base,
            type: 'openshop:tool:exported',
            format: 'png',
            filename: 'tool-output.png',
            blob: outputBlob,
            document: descriptorAfter,
          })
        }
      })
    }),
  } as unknown as Window
  const frame = {
    style: {},
    contentWindow: frameWindow,
    setAttribute: vi.fn(),
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      let bucket = frameListeners.get(type)
      if (!bucket) frameListeners.set(type, bucket = new Set())
      bucket.add(listener)
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => frameListeners.get(type)?.delete(listener)),
    remove: vi.fn(),
  } as unknown as HTMLIFrameElement
  const hostWindow = {
    location: { href: `${targetOrigin}/`, origin: targetOrigin },
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      let bucket = messageListeners.get(type)
      if (!bucket) messageListeners.set(type, bucket = new Set())
      bucket.add(listener)
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => messageListeners.get(type)?.delete(listener)),
  } as unknown as Window
  const hostDocument = {
    createElement: vi.fn(() => frame),
    body: {
      appendChild: vi.fn(() => {
        if (options.appendError) throw options.appendError
        queueMicrotask(() => {
          for (const listener of frameListeners.get('load') ?? []) listener(new Event('load'))
        })
      }),
    },
  } as unknown as Document
  const defaultSave: OpenShopToolRunnerDependencies['saveOutput'] = vi.fn(async (_source, _asset, _blob, context) => {
    context.onCommit()
    return task()
  })

  let decodeCall = 0
  vi.stubGlobal('createImageBitmap', vi.fn(async () => {
    decodeCall += 1
    return { width: decodeCall === 1 ? 3 : 2, height: 2, close: vi.fn() }
  }))

  return {
    dependencies: {
      hostWindow,
      hostDocument,
      loadInput: options.loadInput ?? vi.fn(async () => ({ blob: inputBlob, name: 'source.png' })),
      saveOutput: options.saveOutput ?? defaultSave,
    },
    frame,
    frameListeners,
    messageListeners,
    postedTypes,
    outputBlob,
  }
}

function runWithHarness(harness: RunnerHarness, overrides: Partial<Parameters<typeof openShopToolRunner>[0]> = {}) {
  return openShopToolRunner({
    sourceTaskId: 'source-task',
    inputAssetId: 'source-image',
    commands: [{
      schemaVersion: 1,
      id: 'canvas.crop',
      target: 'document',
      args: { x: 1, y: 0, width: 2, height: 2 },
    }],
    outputFormat: 'png',
    ...overrides,
  }, harness.dependencies)
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('OpenShopToolBridgeClient', () => {
  it('只接受匹配 source/origin/session/id/requestId/type/schema 的响应', async () => {
    const targetOrigin = 'https://example.test'
    const posted: Array<Record<string, unknown>> = []
    const frameWindow = { postMessage: vi.fn((message: Record<string, unknown>) => posted.push(message)) } as unknown as Window
    const messages = createMessageHost(frameWindow, targetOrigin)
    const client = new OpenShopToolBridgeClient(messages.host, frameWindow, targetOrigin, 'session-1')

    const pending = client.request<Extract<OpenShopToolResponseMessage, { type: 'openshop:tool:ready' }>>(
      'openshop:tool:hello',
      'openshop:tool:ready',
      {},
      { timeoutMs: 1_000 },
    )
    const requestId = String(posted[0].id)
    const response = readyMessage(requestId, 'session-1')

    messages.emit({ ...response, id: 'unknown-id', requestId: 'unknown-id' })
    messages.emit(response, {} as Window)
    messages.emit(response, frameWindow, 'https://other.test')
    messages.emit(response)
    await expect(pending).resolves.toMatchObject(response)

    expect(posted[0]).toMatchObject({ id: requestId, requestId, sessionId: 'session-1' })
    expect(messages.listenerCount()).toBe(1)
    client.dispose()
    expect(messages.listenerCount()).toBe(0)
  })

  it.each([
    ['wrong requestId', (message: Record<string, unknown>) => ({ ...message, requestId: 'other' })],
    ['wrong session', (message: Record<string, unknown>) => ({ ...message, sessionId: 'other-session' })],
    ['unknown field', (message: Record<string, unknown>) => ({ ...message, extra: true })],
    ['wrong type', (message: Record<string, unknown>) => ({ ...message, type: 'openshop:tool:configured', document: { canvas: { width: 1, height: 1 }, primaryImage: { present: true } }, capabilities: undefined })],
  ])('命中 pending id 但响应 %s 时立即拒绝', async (_label, mutate) => {
    const targetOrigin = 'https://example.test'
    let posted: Record<string, unknown> = {}
    const frameWindow = { postMessage: vi.fn((message: Record<string, unknown>) => { posted = message }) } as unknown as Window
    const messages = createMessageHost(frameWindow, targetOrigin)
    const client = new OpenShopToolBridgeClient(messages.host, frameWindow, targetOrigin, 'session-1')
    const pending = client.request<Extract<OpenShopToolResponseMessage, { type: 'openshop:tool:ready' }>>(
      'openshop:tool:hello',
      'openshop:tool:ready',
      {},
      { timeoutMs: 1_000 },
    )

    messages.emit(mutate(readyMessage(posted.id, 'session-1')))

    await expect(pending).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    client.dispose()
  })

  it('透传严格错误并在 timeout/abort/dispose 时清理 timer', async () => {
    vi.useFakeTimers()
    const targetOrigin = 'https://example.test'
    const posted: Array<Record<string, unknown>> = []
    const frameWindow = { postMessage: vi.fn((message: Record<string, unknown>) => posted.push(message)) } as unknown as Window
    const messages = createMessageHost(frameWindow, targetOrigin)
    const client = new OpenShopToolBridgeClient(messages.host, frameWindow, targetOrigin, 'session-1')

    const failed = client.request<Extract<OpenShopToolResponseMessage, { type: 'openshop:tool:executed' }>>(
      'openshop:tool:execute',
      'openshop:tool:executed',
      { commands: [{ schemaVersion: 1, id: 'canvas.flatten', target: 'document', args: {} }] },
      { timeoutMs: 1_000 },
    )
    messages.emit({
      ...toolBase(posted[0].id, 'session-1'),
      type: 'openshop:tool:error',
      code: 'VALIDATION_FAILED',
      message: 'bad crop',
      retryable: false,
      commandIndex: 0,
    })
    await expect(failed).rejects.toMatchObject({ code: 'VALIDATION_FAILED', commandIndex: 0 })

    const timedOut = client.request<Extract<OpenShopToolResponseMessage, { type: 'openshop:tool:exported' }>>(
      'openshop:tool:export',
      'openshop:tool:exported',
      { format: 'png' },
      { timeoutMs: 50 },
    )
    const timedOutAssertion = expect(timedOut).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(50)
    await timedOutAssertion

    const controller = new AbortController()
    const cancelled = client.request<Extract<OpenShopToolResponseMessage, { type: 'openshop:tool:configured' }>>(
      'openshop:tool:configure',
      'openshop:tool:configured',
      { document: { blob: new Blob([new Uint8Array([1])], { type: 'image/png' }), name: 'source.png' } },
      { timeoutMs: 1_000, signal: controller.signal },
    )
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' })

    const disposed = client.request<Extract<OpenShopToolResponseMessage, { type: 'openshop:tool:ready' }>>(
      'openshop:tool:hello',
      'openshop:tool:ready',
      {},
      { timeoutMs: 1_000 },
    )
    client.dispose(new OpenShopToolRunnerError('TIMEOUT', 'hard timeout'))
    await expect(disposed).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('握手用同一 requestId 重试，并在 ready 后停止 retry timer', async () => {
    vi.useFakeTimers()
    const targetOrigin = 'https://example.test'
    const posted: Array<Record<string, unknown>> = []
    const frameWindow = { postMessage: vi.fn((message: Record<string, unknown>) => posted.push(message)) } as unknown as Window
    const messages = createMessageHost(frameWindow, targetOrigin)
    const client = new OpenShopToolBridgeClient(messages.host, frameWindow, targetOrigin, 'session-1')
    const pending = client.request<Extract<OpenShopToolResponseMessage, { type: 'openshop:tool:ready' }>>(
      'openshop:tool:hello',
      'openshop:tool:ready',
      {},
      { timeoutMs: 1_000, retryMs: 25 },
    )

    await vi.advanceTimersByTimeAsync(50)
    expect(posted).toHaveLength(3)
    expect(new Set(posted.map((message) => message.id))).toHaveLength(1)
    expect(new Set(posted.map((message) => message.requestId))).toHaveLength(1)
    messages.emit(readyMessage(posted[0].id, 'session-1'))
    await expect(pending).resolves.toMatchObject({ type: 'openshop:tool:ready' })
    await vi.advanceTimersByTimeAsync(100)
    expect(posted).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
    client.dispose()
  })
})

describe('openShopToolRunner', () => {
  it('仅执行导出模式返回已校验 Blob，且不进入最终 Task 保存', async () => {
    const harness = createRunnerHarness()

    const result = await runWithHarness(harness, { saveOutput: false })

    expect(result).toMatchObject({
      blob: harness.outputBlob,
      filename: 'tool-output.png',
      document: { canvas: { width: 2, height: 2 } },
    })
    expect(harness.dependencies.saveOutput).not.toHaveBeenCalled()
    expect(harness.frame.remove).toHaveBeenCalledOnce()
  })

  it('按严格时序完成并销毁固定尺寸 iframe/listener', async () => {
    const harness = createRunnerHarness()

    const result = await runWithHarness(harness)

    expect(harness.postedTypes).toEqual([
      'openshop:tool:hello',
      'openshop:tool:configure',
      'openshop:tool:execute',
      'openshop:tool:export',
    ])
    expect(result).toMatchObject({ filename: 'tool-output.png', document: { canvas: { width: 2, height: 2 } } })
    expect(harness.dependencies.saveOutput).toHaveBeenCalledWith(
      'source-task',
      'source-image',
      harness.outputBlob,
      expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: expect.any(Number), onCommit: expect.any(Function) }),
    )
    expect(harness.frame.style.width).toBe('1280px')
    expect(harness.frame.style.height).toBe('900px')
    expect(harness.frame.remove).toHaveBeenCalledOnce()
    expect(harness.messageListeners.get('message')?.size ?? 0).toBe(0)
    expect(harness.frameListeners.get('load')?.size ?? 0).toBe(0)
  })

  it('从入口总 deadline 取消卡住的 loadInput，迟到 resolve 不创建 iframe', async () => {
    vi.useFakeTimers()
    const loading = deferred<{ blob: Blob; name: string }>()
    const harness = createRunnerHarness({ loadInput: vi.fn(() => loading.promise) })
    const running = runWithHarness(harness, { timeouts: { hardLimitMs: 50 } })
    const assertion = expect(running).rejects.toMatchObject({ code: 'TIMEOUT' })

    await vi.advanceTimersByTimeAsync(50)
    await assertion
    loading.resolve({
      blob: new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }),
      name: 'late.png',
    })
    await Promise.resolve()

    expect(harness.dependencies.hostDocument.createElement).not.toHaveBeenCalled()
  })

  it('拒绝声明为 PNG 但 magic bytes 为 JPEG 的输入', async () => {
    const fakePng = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/png' })
    const harness = createRunnerHarness({ inputBlob: fakePng })

    await expect(runWithHarness(harness)).rejects.toMatchObject({ code: 'IMPORT_FAILED' })
    expect(harness.dependencies.hostDocument.createElement).not.toHaveBeenCalled()
  })

  it('appendChild 同步抛错时立即清理 frame listener/timer，且不会保存', async () => {
    vi.useFakeTimers()
    const harness = createRunnerHarness({ appendError: new Error('append failed') })

    await expect(runWithHarness(harness)).rejects.toMatchObject({ code: 'IMPORT_FAILED' })

    expect(harness.frameListeners.get('load')?.size ?? 0).toBe(0)
    expect(harness.frameListeners.get('error')?.size ?? 0).toBe(0)
    expect(harness.frame.remove).toHaveBeenCalledOnce()
    expect(harness.dependencies.saveOutput).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('卡住的 save 按总 deadline 失败，并通过统一 signal 取消未提交保存', async () => {
    vi.useFakeTimers()
    let saveSignal: AbortSignal | null = null
    const saveOutput = vi.fn((_source: string | null, _asset: string, _blob: Blob, context: OpenShopToolSaveContext) => {
      saveSignal = context.signal
      return new Promise<TaskRecord>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
      })
    })
    const harness = createRunnerHarness({ saveOutput })
    const running = runWithHarness(harness, { timeouts: { hardLimitMs: 5_000 } })
    await vi.waitFor(() => expect(saveOutput).toHaveBeenCalledOnce())
    const assertion = expect(running).rejects.toMatchObject({ code: 'TIMEOUT' })

    await vi.advanceTimersByTimeAsync(5_000)
    await assertion

    expect((saveSignal as AbortSignal | null)?.aborted).toBe(true)
    expect(harness.frame.remove).toHaveBeenCalledOnce()
  })

  it('save 中外部 Abort 取消未提交保存', async () => {
    const controller = new AbortController()
    const saveStarted = deferred<void>()
    const saveOutput = vi.fn((_source: string | null, _asset: string, _blob: Blob, context: OpenShopToolSaveContext) => {
      saveStarted.resolve()
      return new Promise<TaskRecord>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
      })
    })
    const harness = createRunnerHarness({ saveOutput })
    const running = runWithHarness(harness, { signal: controller.signal })
    await saveStarted.promise

    controller.abort()

    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(harness.frame.remove).toHaveBeenCalledOnce()
  })

  it('save timeout 后迟到 resolve 不能落库或把 Runner 改为成功', async () => {
    vi.useFakeTimers()
    const late = deferred<TaskRecord>()
    let landed = false
    const saveOutput = vi.fn((_source: string | null, _asset: string, _blob: Blob, context: OpenShopToolSaveContext) => (
      late.promise.then((value) => {
        if (!context.signal.aborted) landed = true
        return value
      })
    ))
    const harness = createRunnerHarness({ saveOutput })
    const running = runWithHarness(harness, { timeouts: { hardLimitMs: 5_000 } })
    await vi.waitFor(() => expect(saveOutput).toHaveBeenCalledOnce())
    const assertion = expect(running).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion

    late.resolve(task('late-task'))
    await Promise.resolve()
    await Promise.resolve()

    expect(landed).toBe(false)
  })

  it('transaction 已 oncomplete 后到来的 Abort 不会覆盖成功结果', async () => {
    const controller = new AbortController()
    const saveOutput = vi.fn(async (_source: string | null, _asset: string, _blob: Blob, context: OpenShopToolSaveContext) => {
      context.onCommit()
      controller.abort()
      await Promise.resolve()
      return task('committed-task')
    })
    const harness = createRunnerHarness({ saveOutput })

    await expect(runWithHarness(harness, { signal: controller.signal })).resolves.toMatchObject({
      task: { id: 'committed-task' },
    })
  })
})

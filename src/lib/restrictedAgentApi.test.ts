import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAutoPipeline,
  decodeRestrictedAgentAssetBindings,
  decodeRestrictedAgentAutoPipeline,
  decodeRestrictedAgentExecution,
  decodeRestrictedAgentExecutionEvent,
  decodeRestrictedAgentPlan,
  hashComposerSnapshotManifest,
} from './restrictedAgentApi'
import { unifiedAgentGatewayFixture } from '../test/fixtures/unifiedAgentGateway'

afterEach(() => {
  vi.restoreAllMocks()
})

function nonAscendingReferencePlan() {
  return {
    ...unifiedAgentGatewayFixture.plan,
    inputs: [
      {
        assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        role: 'reference',
        sha256: '1'.repeat(64),
        mimeType: 'image/png',
        width: 100,
        height: 100,
      },
      {
        assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        role: 'reference',
        sha256: '2'.repeat(64),
        mimeType: 'image/jpeg',
        width: 100,
        height: 100,
      },
    ],
  }
}

function nonAscendingReferenceBindings() {
  return [
    {
      gatewayAssetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      browserImageId: 'browser-reference-1',
      sourceTaskId: null,
      role: 'reference',
      ordinal: 1,
    },
    {
      gatewayAssetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      browserImageId: 'browser-reference-0',
      sourceTaskId: null,
      role: 'reference',
      ordinal: 0,
    },
  ]
}

describe('unified Agent Gateway v3 client contract', () => {
  it('中止的 capabilities 探测不会成为并发请求共享的 pending promise', async () => {
    // 使用独立模块实例，避免本文件其他用例的 capabilities 缓存影响并发语义验证。
    vi.resetModules()
    const { getRestrictedAgentCapabilities: getFreshCapabilities } = await import('./restrictedAgentApi')
    const controller = new AbortController()
    let probeSignal: AbortSignal | undefined
    let fetchCount = 0
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      fetchCount += 1
      if (fetchCount === 1) {
        probeSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          probeSignal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          }, { once: true })
        })
      }
      return Promise.resolve(new Response(JSON.stringify({
        data: { enabled: true, csrfToken: 'concurrent-csrf' },
      }), { status: 200 }))
    })

    const abortedProbe = getFreshCapabilities({ refresh: true, signal: controller.signal })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const concurrentRequest = getFreshCapabilities()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    expect(probeSignal).toBe(controller.signal)
    controller.abort()
    await expect(abortedProbe).rejects.toMatchObject({ name: 'AbortError' })
    await expect(concurrentRequest).resolves.toMatchObject({ csrfToken: 'concurrent-csrf' })
  })

  it('带 signal 的 capabilities 探测不会复用既有的普通 pending promise', async () => {
    vi.resetModules()
    const { getRestrictedAgentCapabilities: getFreshCapabilities } = await import('./restrictedAgentApi')
    const controller = new AbortController()
    let resolveSharedRequest!: (response: Response) => void
    let isolatedSignal: AbortSignal | undefined
    let fetchCount = 0
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      fetchCount += 1
      if (fetchCount === 1) {
        return new Promise<Response>((resolve) => {
          resolveSharedRequest = resolve
        })
      }
      isolatedSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        isolatedSignal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
    })

    const sharedRequest = getFreshCapabilities({ refresh: true })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const cancelledProbe = getFreshCapabilities({ signal: controller.signal })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    expect(isolatedSignal).toBe(controller.signal)
    controller.abort()
    await expect(cancelledProbe).rejects.toMatchObject({ name: 'AbortError' })
    resolveSharedRequest(new Response(JSON.stringify({
      data: { enabled: true, csrfToken: 'shared-csrf' },
    }), { status: 200 }))
    await expect(sharedRequest).resolves.toMatchObject({ csrfToken: 'shared-csrf' })
  })

  it('strictly decodes the v3 auto pipeline plan, execution actions and action SSE event', () => {
    const execution = decodeRestrictedAgentExecution(unifiedAgentGatewayFixture.execution)
    const actionEvent = decodeRestrictedAgentExecutionEvent('action.started', unifiedAgentGatewayFixture.actionStarted)

    expect(execution.actions).toHaveLength(3)
    expect(execution.actions?.[1]).toMatchObject({ type: 'image.transform', status: 'queued' })
    expect(actionEvent).toMatchObject({
      type: 'action.started',
      data: { actionIndex: 1, type: 'image.transform', status: 'executing' },
    })
  })

  it('rejects malformed v3 action payloads rather than accepting partial progress', () => {
    const malformedAction = structuredClone(unifiedAgentGatewayFixture.actionStarted)
    delete (malformedAction as { id?: string }).id

    expect(() => decodeRestrictedAgentExecutionEvent('action.started', malformedAction))
      .toThrow('执行 action schema 无效')
  })

  it('submits finalOutputSpec to the automatic v3 pipeline endpoint and verifies frozen input', async () => {
    const request = {
      request: '生成一张 870×220 的夏日咖啡横幅',
      size: '1536x1024',
      quality: 'high' as const,
      outputFormat: 'png' as const,
      outputCompression: null,
      moderation: 'auto' as const,
      imageCount: 1,
      inputs: [],
      temporaryProfile: { id: null, name: null, missing: false },
      finalOutputSpec: unifiedAgentGatewayFixture.plan.finalOutputSpec,
    }
    const composerSnapshotHash = await hashComposerSnapshotManifest({
      schemaVersion: 2,
      scope: 'tool',
      prompt: request.request,
      inputs: [],
      mask: null,
      params: {
        size: request.size,
        quality: request.quality,
        outputFormat: request.outputFormat,
        outputCompression: request.outputCompression,
        moderation: request.moderation,
        imageCount: request.imageCount,
      },
      temporaryProfile: request.temporaryProfile,
    })
    const response = {
      data: {
        plan: { ...unifiedAgentGatewayFixture.plan, composerSnapshotHash },
        execution: unifiedAgentGatewayFixture.execution,
        assetBindings: unifiedAgentGatewayFixture.assetBindings,
      },
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { enabled: true, csrfToken: 'csrf-v3' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 202 }))

    const result = await createAutoPipeline(request)

    expect(result.plan).toMatchObject({ schemaVersion: 3, finalOutputSpec: request.finalOutputSpec })
    expect(result.execution.actions).toHaveLength(3)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/agent-api/v1/plans/auto-execute')
    const form = fetchMock.mock.calls[1]?.[1]?.body as FormData
    expect(JSON.parse(String(form.get('finalOutputSpec')))).toEqual(request.finalOutputSpec)
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-v3' })
  })
})

describe('Agent Gateway asset binding decoder', () => {
  it('接受按实际 role ordinal 返回的非升序 Composer manifest binding', () => {
    const plan = nonAscendingReferencePlan()
    const assetBindings = nonAscendingReferenceBindings()

    const pipeline = decodeRestrictedAgentAutoPipeline({
      plan,
      execution: unifiedAgentGatewayFixture.execution,
      assetBindings,
    })

    expect(pipeline.assetBindings).toEqual(assetBindings)
  })

  it.each([
    ['重复同角色 ordinal', (bindings: ReturnType<typeof nonAscendingReferenceBindings>) => { bindings[1]!.ordinal = 1 }],
    ['越界同角色 ordinal', (bindings: ReturnType<typeof nonAscendingReferenceBindings>) => { bindings[1]!.ordinal = 2 }],
    ['重复浏览器图片 binding', (bindings: ReturnType<typeof nonAscendingReferenceBindings>) => { bindings[1]!.browserImageId = bindings[0]!.browserImageId }],
    ['跨角色 binding', (bindings: ReturnType<typeof nonAscendingReferenceBindings>) => { bindings[1]!.role = 'mask_target' }],
  ])('拒绝%s', (_label, mutate) => {
    const plan = decodeRestrictedAgentPlan(nonAscendingReferencePlan())
    const bindings = nonAscendingReferenceBindings()
    mutate(bindings)

    expect(() => decodeRestrictedAgentAssetBindings(plan, bindings))
      .toThrow('计划 asset binding 与计划输入不一致')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RestrictedAgentPlan } from '../types'
import { hashComposerSnapshotManifest, streamRestrictedAgentPlan } from './restrictedAgentApi'

const request = {
  request: '生成海报',
  size: '1024x1024',
  quality: 'high' as const,
  outputFormat: 'png' as const,
  outputCompression: null,
  moderation: 'auto' as const,
  imageCount: 1,
  inputs: [],
  temporaryProfile: { id: null, name: null, missing: false },
}

async function createPlan(): Promise<RestrictedAgentPlan> {
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
  return {
    schemaVersion: 2,
    composerSnapshotHash,
    id: '11111111-1111-4111-8111-111111111111',
    version: 1,
    status: 'awaiting_confirmation',
    expiresAt: '2099-01-01T00:00:00.000Z',
    originalRequest: request.request,
    summary: '海报计划',
    assistantMessage: '我将生成一张符合需求的海报。',
    operation: {
      type: 'image.generate',
      generation: {
        exactPrompt: '完整海报提示词', action: 'generate', size: request.size, quality: request.quality,
        outputFormat: request.outputFormat, outputCompression: null, imageCount: request.imageCount,
      },
    },
    inputs: [],
    assumptions: [],
    warnings: [],
    policyVersion: 'tool-operation-v2',
  }
}

function streamResponse(parts: string[]) {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      parts.forEach((part) => controller.enqueue(encoder.encode(part)))
      controller.close()
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

afterEach(() => vi.restoreAllMocks())

describe('restricted Agent plan stream client', () => {
  it('以与普通规划相同的 multipart POST 读取分片 delta 与最终计划', async () => {
    const plan = await createPlan()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/capabilities')) {
        return new Response(JSON.stringify({ data: { enabled: true, csrfToken: 'csrf-1' } }), { status: 200 })
      }
      return streamResponse([
        'event: plan.delta\ndata: {"text":"正在"}\n\n',
        'event: plan.delta\ndata: {"text":"规划"}\n\n',
        `event: plan.completed\ndata: ${JSON.stringify(plan)}\n\n`,
      ])
    })
    const deltas: string[] = []

    const result = await streamRestrictedAgentPlan(request, { onDelta: (text) => deltas.push(text) })

    expect(result).toEqual({ plan, assetBindings: [] })
    expect(deltas).toEqual(['正在', '规划'])
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/plans/stream'))!
    expect(init).toMatchObject({ method: 'POST', headers: expect.objectContaining({ Accept: 'text/event-stream', 'X-CSRF-Token': 'csrf-1' }) })
    expect((init?.body as FormData).get('composerSnapshot')).toBeTruthy()
  })

  it('将流式失败事件作为错误抛出，同时保留已发送的增量回调', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/capabilities')) {
        return new Response(JSON.stringify({ data: { enabled: true, csrfToken: 'csrf-1' } }), { status: 200 })
      }
      return streamResponse([
        'event: plan.delta\ndata: {"text":"正在分析"}\n\n',
        'event: plan.failed\ndata: {"message":"规划服务不可用"}\n\n',
      ])
    })
    const deltas: string[] = []

    await expect(streamRestrictedAgentPlan(request, { onDelta: (text) => deltas.push(text) }))
      .rejects.toThrow('规划服务不可用')

    expect(deltas).toEqual(['正在分析'])
    expect(fetchMock).toHaveBeenCalled()
  })
})

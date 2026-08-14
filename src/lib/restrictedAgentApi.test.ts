import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAutoPipeline,
  decodeRestrictedAgentExecution,
  decodeRestrictedAgentExecutionEvent,
  hashComposerSnapshotManifest,
} from './restrictedAgentApi'
import { unifiedAgentGatewayFixture } from '../test/fixtures/unifiedAgentGateway'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('unified Agent Gateway v3 client contract', () => {
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

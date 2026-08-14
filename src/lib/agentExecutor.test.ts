import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error node:fs 仅用于读取不会进入生产 bundle 的共享 contract fixture
import { readFileSync } from 'node:fs'
import type { RestrictedAgentExecution, RestrictedAgentPlan } from '../types'
import {
  createRestrictedAgentPlan,
  decodeRestrictedAgentPlan,
  executeRestrictedAgentPlan,
} from './agentExecutor'
import { decodeRestrictedAgentAssetBindings, hashComposerSnapshotManifest } from './restrictedAgentApi'

interface ContractFixture {
  canonicalComposer: { manifest: Record<string, unknown>; expectedHash: string }
  validPlans: { tool: Record<string, unknown>; legacy: Record<string, unknown> }
  invalidPlanMutations: Array<{
    name: string
    base: 'tool' | 'legacy'
    path: Array<string | number>
    value: unknown
  }>
}

const contractFixture = JSON.parse(
  readFileSync(new URL('../../test-fixtures/restricted-agent-contract.json', import.meta.url), 'utf8'),
) as ContractFixture

function applyInvalidPlanMutation(mutation: ContractFixture['invalidPlanMutations'][number]) {
  const plan = structuredClone(contractFixture.validPlans[mutation.base])
  let target: Record<string | number, unknown> = plan
  for (const key of mutation.path.slice(0, -1)) target = target[key] as Record<string | number, unknown>
  target[mutation.path[mutation.path.length - 1]!] = structuredClone(mutation.value)
  return plan
}

async function sha256Hex(value: Uint8Array | string) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function createPlanFixture(): Promise<RestrictedAgentPlan> {
  const contentSha256 = await sha256Hex(new TextEncoder().encode('image'))
  const composerSnapshotHash = await sha256Hex(JSON.stringify({
    schemaVersion: 2,
    scope: 'tool',
    prompt: '生成海报',
    inputs: [{
      browserImageId: 'browser-image-1',
      contentSha256,
      role: 'reference',
      ordinal: 0,
    }],
    mask: null,
    params: {
      size: '1024x1024', quality: 'high', outputFormat: 'png', outputCompression: null,
      moderation: 'auto', imageCount: 1,
    },
    temporaryProfile: { id: null, name: null, missing: false },
  }))
  return {
    schemaVersion: 2,
    composerSnapshotHash,
    id: '11111111-1111-4111-8111-111111111111',
    version: 3,
    status: 'awaiting_confirmation',
    expiresAt: '2099-01-01T00:00:00.000Z',
    originalRequest: '生成海报',
    summary: '产品海报',
    operation: {
      type: 'image.generate',
      generation: {
        exactPrompt: '完整产品海报提示词',
        action: 'generate',
        size: '1024x1024',
        quality: 'high',
        outputFormat: 'png',
        outputCompression: null,
        imageCount: 1,
      },
    },
    inputs: [{
      assetId: '22222222-2222-4222-8222-222222222222', role: 'reference', sha256: 'a'.repeat(64),
      mimeType: 'image/png', width: 1, height: 1,
    }],
    assumptions: [],
    warnings: [],
    policyVersion: 'tool-operation-v2',
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('restricted Agent gateway client', () => {
  it('创建 v2 计划时发送完整 Composer 快照并建立本地 asset binding', async () => {
    const plan = await createPlanFixture()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { enabled: true, csrfToken: 'csrf-1' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: plan }), { status: 200 }))

    const result = await createRestrictedAgentPlan({
      request: '生成海报',
      size: '1024x1024',
      quality: 'high',
      outputFormat: 'png',
      outputCompression: null,
      moderation: 'auto',
      imageCount: 1,
      inputs: [{
        role: 'reference',
        browserImageId: 'browser-image-1',
        sourceTaskId: 'task-source-1',
        dataUrl: 'data:image/png;base64,aW1hZ2U=',
      }],
      temporaryProfile: { id: null, name: null, missing: false },
    })

    expect(result.plan).toEqual(plan)
    expect(result.assetBindings).toEqual([{
      gatewayAssetId: '22222222-2222-4222-8222-222222222222',
      browserImageId: 'browser-image-1',
      sourceTaskId: 'task-source-1',
      role: 'reference',
      ordinal: 0,
    }])
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/agent-api/v1/capabilities')
    const [, init] = fetchMock.mock.calls[1]!
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/agent-api/v1/plans')
    expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' })
    const body = init?.body as FormData
    expect([...body.keys()].sort()).toEqual([
      'composerSnapshot', 'imageCount', 'outputFormat', 'quality', 'reference', 'request', 'size', 'webSearchEnabled',
    ])
    expect(body.get('webSearchEnabled')).toBe('false')
    expect(JSON.parse(String(body.get('composerSnapshot')))).toMatchObject({
      schemaVersion: 2,
      scope: 'tool',
      prompt: '生成海报',
      inputs: [{ browserImageId: 'browser-image-1', role: 'reference', ordinal: 0 }],
    })
    expect(body.has('model')).toBe(false)
    expect(body.has('tools')).toBe(false)
    expect(body.has('upstream')).toBe(false)
  })

  it('确认 v2 计划只发送 plan version 与当前 Composer hash', async () => {
    const plan = await createPlanFixture()
    const execution: RestrictedAgentExecution = {
      id: '33333333-3333-4333-8333-333333333333', planId: plan.id, status: 'queued', cancelRequested: false, error: null,
      outputAssets: [], createdAt: '2026-07-16T00:00:00.000Z', startedAt: null,
      completedAt: null, updatedAt: '2026-07-16T00:00:00.000Z',
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: execution }), { status: 200 }))

    const result = await executeRestrictedAgentPlan(plan, plan.schemaVersion === 2 ? plan.composerSnapshotHash : null)

    expect(result).toEqual({ ...execution, actions: [] })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/agent-api/v1/plans/11111111-1111-4111-8111-111111111111/execute')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBeUndefined()
    expect(init?.headers).toMatchObject({
      'If-Match': '"3"',
      'X-Composer-Snapshot-Hash': plan.schemaVersion === 2 ? plan.composerSnapshotHash : '',
      'X-CSRF-Token': 'csrf-1',
    })
  })

  it('runtime decoder拒绝未知schema、actions与v2混合generation字段', async () => {
    const plan = await createPlanFixture()
    expect(() => decodeRestrictedAgentPlan({ ...plan, schemaVersion: 3 })).toThrow('Tool Plan schema 无效')
    expect(() => decodeRestrictedAgentPlan({ ...plan, actions: [] })).toThrow('Tool Plan schema 无效')
    expect(() => decodeRestrictedAgentPlan({ ...plan, generation: plan.operation })).toThrow('Tool Plan schema 无效')
  })

  it('前后端共享 canonical Composer fixture 具有固定 hash', async () => {
    expect(await hashComposerSnapshotManifest(contractFixture.canonicalComposer.manifest as never))
      .toBe(contractFixture.canonicalComposer.expectedHash)
  })

  it('runtime decoder 与 Gateway 共同拒绝表驱动非法计划', () => {
    expect(decodeRestrictedAgentPlan(structuredClone(contractFixture.validPlans.tool))).toBeTruthy()
    expect(decodeRestrictedAgentPlan(structuredClone(contractFixture.validPlans.legacy))).toBeTruthy()
    for (const mutation of contractFixture.invalidPlanMutations) {
      expect(
        () => decodeRestrictedAgentPlan(applyInvalidPlanMutation(mutation)),
        mutation.name,
      ).toThrow()
    }
  })

  it('binding decoder 拒绝缺失、错序与重复 Gateway/浏览器绑定', () => {
    const bindingPlan = decodeRestrictedAgentPlan({
      ...structuredClone(contractFixture.validPlans.tool),
      operation: {
        type: 'image.edit',
        generation: {
          exactPrompt: '编辑两张参考图', action: 'edit', size: '1024x1024', quality: 'medium',
          outputFormat: 'png', outputCompression: null, imageCount: 1,
        },
      },
      inputs: [
        { assetId: '33333333-3333-4333-8333-333333333333', role: 'reference', sha256: 'a'.repeat(64), mimeType: 'image/png', width: 1, height: 1 },
        { assetId: '44444444-4444-4444-8444-444444444444', role: 'reference', sha256: 'b'.repeat(64), mimeType: 'image/png', width: 1, height: 1 },
      ],
    })
    const validBindings = [
      { gatewayAssetId: bindingPlan.inputs[0]!.assetId, browserImageId: 'browser-1', sourceTaskId: 'task-1', role: 'reference' as const, ordinal: 0 },
      { gatewayAssetId: bindingPlan.inputs[1]!.assetId, browserImageId: 'browser-2', sourceTaskId: 'task-2', role: 'reference' as const, ordinal: 1 },
    ]
    expect(decodeRestrictedAgentAssetBindings(bindingPlan, validBindings)).toEqual(validBindings)
    for (const invalid of [
      validBindings.slice(0, 1),
      [validBindings[1], validBindings[0]],
      [validBindings[0], { ...validBindings[1]!, role: 'mask_target' as const }],
      [validBindings[0], { ...validBindings[1]!, ordinal: 0 }],
      [validBindings[0], { ...validBindings[1]!, gatewayAssetId: validBindings[0]!.gatewayAssetId }],
      [validBindings[0], { ...validBindings[1]!, browserImageId: validBindings[0]!.browserImageId }],
    ]) {
      expect(() => decodeRestrictedAgentAssetBindings(bindingPlan, invalid)).toThrow()
    }

    const maskPlan = decodeRestrictedAgentPlan({
      ...structuredClone(contractFixture.validPlans.tool),
      operation: {
        type: 'image.edit',
        generation: {
          exactPrompt: '局部编辑', action: 'edit', size: '1024x1024', quality: 'medium',
          outputFormat: 'png', outputCompression: null, imageCount: 1,
        },
      },
      inputs: [
        { assetId: '55555555-5555-4555-8555-555555555555', role: 'mask_target', sha256: 'c'.repeat(64), mimeType: 'image/png', width: 1, height: 1 },
        { assetId: '66666666-6666-4666-8666-666666666666', role: 'mask', sha256: 'd'.repeat(64), mimeType: 'image/png', width: 1, height: 1 },
      ],
    })
    const maskBindings = [
      { gatewayAssetId: maskPlan.inputs[0]!.assetId, browserImageId: 'mask-target', sourceTaskId: 'task-mask-target', role: 'mask_target' as const, ordinal: 0 },
      { gatewayAssetId: maskPlan.inputs[1]!.assetId, browserImageId: null, sourceTaskId: null, role: 'mask' as const, ordinal: 0 },
    ]
    expect(decodeRestrictedAgentAssetBindings(maskPlan, maskBindings)).toEqual(maskBindings)
    expect(() => decodeRestrictedAgentAssetBindings(maskPlan, [
      maskBindings[0]!,
      { ...maskBindings[1]!, sourceTaskId: 'tampered-source-task' },
    ])).toThrow('计划 asset binding 与计划输入不一致')
  })
})

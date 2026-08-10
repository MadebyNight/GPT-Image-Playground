import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ToolAgentPlan } from '../types'
import AgentPlanCard from './AgentPlanCard'

const imagePlan: ToolAgentPlan = {
  schemaVersion: 2,
  composerSnapshotHash: 'a'.repeat(64),
  id: 'plan-1',
  version: 2,
  status: 'awaiting_confirmation',
  expiresAt: '2099-01-01T00:00:00.000Z',
  originalRequest: '生成海报',
  summary: '生成产品发布海报',
  operation: {
    type: 'image.generate',
    generation: {
      exactPrompt: '一张极简产品发布海报',
      action: 'generate',
      size: '1024x1024',
      quality: 'high',
      outputFormat: 'png',
      outputCompression: null,
      imageCount: 1,
    },
  },
  inputs: [],
  assumptions: ['使用中性背景'],
  warnings: ['图片生成会消耗服务端额度'],
  policyVersion: 'tool-operation-v2',
}

const openShopPlan: ToolAgentPlan = {
  ...imagePlan,
  id: 'plan-openshop',
  summary: '顺时针旋转并水平翻转图片',
  operation: {
    type: 'openshop.edit',
    inputAssetId: 'gateway-asset-private-id',
    commands: [
      { schemaVersion: 1, id: 'canvas.rotate', target: 'document', args: { degrees: 90 } },
      { schemaVersion: 1, id: 'canvas.flip', target: 'document', args: { axis: 'h' } },
    ],
    outputFormat: 'png',
  },
  inputs: [{
    assetId: 'gateway-asset-private-id', role: 'reference', sha256: 'b'.repeat(64),
    mimeType: 'image/png', width: 100, height: 80,
  }],
}

describe('AgentPlanCard', () => {
  it('直接展示冻结的 image operation 并保留显式确认', () => {
    const markup = renderToStaticMarkup(
      <AgentPlanCard plan={imagePlan} onConfirm={vi.fn()} onReturnToEditing={vi.fn()} />,
    )

    expect(markup).toContain('image.generate')
    expect(markup).toContain('一张极简产品发布海报')
    expect(markup).toContain('1024x1024')
    expect(markup).toContain('图片生成会消耗服务端额度')
    expect(markup).toContain('确认并执行')
  })

  it('展示实际 OpenShop 命令但隐藏原始ID并禁用确认', () => {
    const markup = renderToStaticMarkup(
      <AgentPlanCard
        plan={openShopPlan}
        assetBindings={[{
          gatewayAssetId: 'gateway-asset-private-id',
          browserImageId: 'browser-indexeddb-private-id',
          sourceTaskId: 'source-task-private-id',
          role: 'reference',
          ordinal: 0,
        }]}
        onConfirm={vi.fn()}
        onReturnToEditing={vi.fn()}
      />,
    )

    expect(markup).toContain('openshop.edit')
    expect(markup).toContain('canvas.rotate')
    expect(markup).toContain('旋转：90°')
    expect(markup).toContain('历史任务输出')
    expect(markup).toContain('等待浏览器执行接入')
    expect(markup).toContain('disabled')
    expect(markup).not.toContain('gateway-asset-private-id')
    expect(markup).not.toContain('browser-indexeddb-private-id')
    expect(markup).not.toContain('source-task-private-id')
  })

  it('stale计划禁用确认并提示重新规划', () => {
    const markup = renderToStaticMarkup(
      <AgentPlanCard plan={imagePlan} stale onConfirm={vi.fn()} onReturnToEditing={vi.fn()} />,
    )
    expect(markup).toContain('计划已过时')
    expect(markup).toContain('disabled')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RestrictedAgentExecution, ToolAgentPlan, ToolAgentPlanV3 } from '../types'
import AgentPlanCard from './AgentPlanCard'

const v3Plan: ToolAgentPlanV3 = {
  schemaVersion: 3,
  composerSnapshotHash: 'a'.repeat(64),
  id: 'plan-v3',
  version: 3,
  status: 'queued',
  expiresAt: '2099-01-01T00:00:00.000Z',
  originalRequest: '生成 870×220 的产品横幅',
  summary: '生成并严格处理产品横幅',
  finalOutputSpec: { width: 870, height: 220, fit: 'cover', position: 'center', outputFormat: 'png' },
  actions: [
    {
      type: 'image.generate',
      generation: {
        exactPrompt: '极简蓝色产品横幅', action: 'generate', size: '1536x1024', quality: 'high', outputFormat: 'png', outputCompression: null, imageCount: 1,
      },
    },
    {
      type: 'image.transform',
      input: { kind: 'action_output', actionIndex: 0 },
      transform: { width: 870, height: 220, fit: 'cover', position: 'center', outputFormat: 'png' },
    },
    {
      type: 'metadata.assert',
      input: { kind: 'action_output', actionIndex: 1 },
      expected: { width: 870, height: 220, outputFormat: 'png' },
    },
  ],
  inputs: [{
    assetId: 'gateway-asset-private-id',
    role: 'reference',
    sha256: 'c'.repeat(64),
    mimeType: 'image/png',
    width: 1200,
    height: 628,
  }],
  assumptions: ['未指定裁剪策略，使用居中 cover'],
  warnings: ['主体可能在居中裁切时靠近边缘。'],
  policyVersion: 'tool-action-v3',
}

const runningExecution: RestrictedAgentExecution = {
  id: 'execution-v3',
  planId: v3Plan.id,
  status: 'executing',
  cancelRequested: false,
  error: null,
  outputAssets: [],
  actions: v3Plan.actions.map((action, actionIndex) => ({
    id: `action-${actionIndex}`,
    executionId: 'execution-v3',
    actionIndex,
    type: action.type,
    normalizedParams: action,
    status: actionIndex === 2 ? 'executing' : 'completed',
    idempotencyKey: `key-${actionIndex}`,
    error: null,
    inputAssets: [],
    outputAssets: [],
    createdAt: '2026-08-14T00:00:00.000Z',
    startedAt: '2026-08-14T00:00:01.000Z',
    completedAt: actionIndex < 2 ? '2026-08-14T00:00:02.000Z' : null,
    updatedAt: '2026-08-14T00:00:03.000Z',
  })),
  createdAt: '2026-08-14T00:00:00.000Z',
  startedAt: '2026-08-14T00:00:01.000Z',
  completedAt: null,
  updatedAt: '2026-08-14T00:00:03.000Z',
}

const legacyPlan: ToolAgentPlan = {
  schemaVersion: 2,
  composerSnapshotHash: 'b'.repeat(64),
  id: 'plan-v2',
  version: 2,
  status: 'awaiting_confirmation',
  expiresAt: '2099-01-01T00:00:00.000Z',
  originalRequest: '旧版图片生成',
  summary: '旧版生成计划',
  operation: {
    type: 'image.generate',
    generation: {
      exactPrompt: '旧版蓝色海报', action: 'generate', size: '1024x1024', quality: 'high', outputFormat: 'png', outputCompression: null, imageCount: 1,
    },
  },
  inputs: [],
  assumptions: [],
  warnings: [],
  policyVersion: 'tool-operation-v2',
}

describe('AgentPlanCard', () => {
  it('shows business action progress with a cancel action and no confirmation controls', () => {
    const markup = renderToStaticMarkup(
      <AgentPlanCard plan={v3Plan} execution={runningExecution} onCancel={vi.fn()} />,
    )

    expect(markup).toContain('图片生成')
    expect(markup).toContain('严格尺寸处理')
    expect(markup).toContain('输出规格校验')
    expect(markup).toContain('正在校验输出规格')
    expect(markup).toContain('最终提示词')
    expect(markup).toContain('极简蓝色产品横幅')
    expect(markup).toContain('输入图片')
    expect(markup).toContain('参考图 1')
    expect(markup).toContain('1200 × 628 · PNG')
    expect(markup).toContain('aria-label="输入图片，共 1 张"')
    expect(markup).toContain('处理风险')
    expect(markup).toContain('主体可能在居中裁切时靠近边缘。')
    expect(markup).toContain('aria-label="取消执行"')
    expect(markup).not.toMatch(/确认|返回修改/)
    expect(markup).not.toContain('image.transform')
    expect(markup).not.toContain('metadata.assert')
    expect(markup).not.toContain('gateway-asset-private-id')
  })

  it('provides an accessible retry action only after a v3 execution fails', () => {
    const failedExecution: RestrictedAgentExecution = {
      ...runningExecution,
      status: 'failed',
      error: { code: 'ASSERT_FAILED', message: '输出规格校验失败' },
      actions: runningExecution.actions?.map((action) => ({
        ...action,
        status: action.actionIndex === 2 ? 'failed' : action.status,
        error: action.actionIndex === 2 ? { code: 'ASSERT_FAILED', message: '输出规格校验失败' } : null,
      })),
    }

    const markup = renderToStaticMarkup(
      <AgentPlanCard plan={v3Plan} execution={failedExecution} onRetry={vi.fn()} />,
    )

    expect(markup).toContain('aria-label="重试"')
    expect(markup).toContain('输出规格校验失败')
    expect(markup).not.toContain('aria-label="取消执行"')
    expect(markup).not.toMatch(/确认|返回修改/)
  })

  it('keeps v1/v2 plans readable without rendering confirmation or recovery actions', () => {
    const markup = renderToStaticMarkup(<AgentPlanCard plan={legacyPlan} />)

    expect(markup).toContain('旧版生成计划')
    expect(markup).toContain('图片生成')
    expect(markup).toContain('只读兼容')
    expect(markup).not.toMatch(/确认|返回修改|取消执行|重试/)
  })

  it('assigns every rendered plan card its own labelled heading', () => {
    const markup = renderToStaticMarkup(
      <>
        <AgentPlanCard plan={v3Plan} execution={runningExecution} />
        <AgentPlanCard plan={{ ...legacyPlan, id: 'plan-v2-second' }} />
      </>,
    )
    const labelledBy = Array.from(
      markup.matchAll(/<article[^>]*data-agent-plan-card[^>]*aria-labelledby="([^"]+)"/g),
      ([, titleId]) => titleId,
    )

    expect(labelledBy).toHaveLength(2)
    expect(new Set(labelledBy).size).toBe(2)
    labelledBy.forEach((titleId) => expect(markup).toContain(`<h2 id="${titleId}"`))
  })
})

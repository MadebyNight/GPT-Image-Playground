import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DEFAULT_PARAMS,
  type RestrictedAgentExecution,
  type TaskRecord,
  type ToolAgentPlan,
  type ToolAgentPlanV3,
} from '../types'

const mocks = vi.hoisted(() => ({
  setLightboxImageId: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
}))

vi.mock('../store', () => ({
  useStore: <T,>(selector: (state: Record<string, unknown>) => T) => selector({
    setLightboxImageId: mocks.setLightboxImageId,
  }),
  ensureImageThumbnailCached: vi.fn(() => Promise.resolve(undefined)),
  subscribeImageThumbnail: vi.fn(() => () => undefined),
}))
vi.mock('../lib/agentExecutor', () => ({
  cancelUnifiedAgentTask: mocks.cancel,
  retryUnifiedAgentTask: mocks.retry,
  cancelAgentTask: mocks.cancel,
  subscribeAgentProgress: vi.fn(() => () => undefined),
}))
vi.mock('./TaskActionRow', () => ({
  default: ({ task, presentation }: { task: TaskRecord; presentation: string }) => (
    <div data-task-action-row={presentation} data-task-id={task.id}>任务操作</div>
  ),
}))

import AgentMainWorkspace from './AgentMainWorkspace'

const v3Plan: ToolAgentPlanV3 = {
  schemaVersion: 3,
  composerSnapshotHash: 'a'.repeat(64),
  id: 'plan-v3',
  version: 3,
  status: 'executing',
  expiresAt: '2099-01-01T00:00:00.000Z',
  originalRequest: '生成 870×220 横幅',
  summary: '严格产品横幅',
  finalOutputSpec: { width: 870, height: 220, outputFormat: 'png' },
  actions: [
    { type: 'image.generate', generation: { exactPrompt: '蓝色产品横幅', action: 'generate', size: '1536x1024', quality: 'high', outputFormat: 'png', outputCompression: null, imageCount: 1 } },
    { type: 'image.transform', input: { kind: 'action_output', actionIndex: 0 }, transform: { width: 870, height: 220, outputFormat: 'png' } },
    { type: 'metadata.assert', input: { kind: 'action_output', actionIndex: 1 }, expected: { width: 870, height: 220, outputFormat: 'png' } },
  ],
  inputs: [],
  assumptions: [],
  warnings: [],
  policyVersion: 'tool-action-v3',
}

const v3Execution: RestrictedAgentExecution = {
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
    status: actionIndex === 1 ? 'executing' : actionIndex === 0 ? 'completed' : 'queued',
    idempotencyKey: `idempotency-${actionIndex}`,
    error: null,
    inputAssets: [],
    outputAssets: [],
    createdAt: '2026-08-14T00:00:00.000Z',
    startedAt: actionIndex === 1 ? '2026-08-14T00:00:01.000Z' : null,
    completedAt: actionIndex === 0 ? '2026-08-14T00:00:01.000Z' : null,
    updatedAt: '2026-08-14T00:00:02.000Z',
  })),
  createdAt: '2026-08-14T00:00:00.000Z',
  startedAt: '2026-08-14T00:00:01.000Z',
  completedAt: null,
  updatedAt: '2026-08-14T00:00:02.000Z',
}

function task(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    prompt: `任务 ${id}`,
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    origin: 'agent',
    agentConversationId: 'conversation-a',
    agentTurn: 1,
    ...patch,
  }
}

const legacyPlan: ToolAgentPlan = {
  schemaVersion: 2,
  composerSnapshotHash: 'b'.repeat(64),
  id: 'legacy-plan',
  version: 2,
  status: 'awaiting_confirmation',
  expiresAt: '2099-01-01T00:00:00.000Z',
  originalRequest: '旧版计划',
  summary: '旧版 Tool 计划',
  operation: { type: 'image.generate', generation: { exactPrompt: '旧版图', action: 'generate', size: '1024x1024', quality: 'high', outputFormat: 'png', outputCompression: null, imageCount: 1 } },
  inputs: [],
  assumptions: [],
  warnings: [],
  policyVersion: 'tool-operation-v2',
}

describe('AgentMainWorkspace', () => {
  beforeEach(() => {
    mocks.setLightboxImageId.mockReset()
    mocks.cancel.mockReset()
    mocks.retry.mockReset()
  })

  it('renders mixed Responses and Gateway turns in turn order in one conversation', () => {
    const responseTurn = task('responses-turn', {
      prompt: '先生成一张产品海报',
      outputImages: ['response-output'],
      agentAssistantText: '图片已生成。',
      agentTurn: 1,
    })
    const pipelineTurn = task('pipeline-turn', {
      prompt: '改成 870×220 横幅',
      status: 'running',
      finishedAt: null,
      elapsed: null,
      agentTurn: 2,
      agentPlanSnapshot: v3Plan,
      agentExecutionSnapshot: v3Execution,
      agentExecutionId: v3Execution.id,
      agentRoute: 'tool_pipeline',
    })

    const markup = renderToStaticMarkup(
      <AgentMainWorkspace task={responseTurn} conversationTasks={[pipelineTurn, responseTurn]} />,
    )

    const responseIndex = markup.indexOf('data-agent-conversation-turn="responses-turn"')
    const pipelineIndex = markup.indexOf('data-agent-conversation-turn="pipeline-turn"')
    expect(responseIndex).toBeGreaterThan(-1)
    expect(pipelineIndex).toBeGreaterThan(responseIndex)
    expect(markup).toContain('图片生成')
    expect(markup).toContain('严格尺寸处理')
    expect(markup).toContain('输出规格校验')
    expect(markup).toContain('aria-label="取消执行"')
    expect(markup).not.toContain('agent-chat-panel')
    expect(markup).not.toContain('agent-tool-panel')
    expect(markup).not.toMatch(/>Chat</)
    expect(markup).not.toMatch(/>Tool</)
  })

  it('keeps a selected conversation isolated from another background execution', () => {
    const selected = task('selected', { agentConversationId: 'conversation-selected' })
    const background = task('background', {
      prompt: '不应抢占的后台任务',
      agentConversationId: 'conversation-background',
      agentPlanSnapshot: v3Plan,
      agentExecutionSnapshot: v3Execution,
      status: 'running',
    })

    const markup = renderToStaticMarkup(
      <AgentMainWorkspace task={selected} conversationTasks={[selected]} />,
    )

    expect(markup).toContain('任务 selected')
    expect(markup).not.toContain(background.prompt)
    expect(markup).not.toContain('execution-v3')
  })

  it('keeps a failed v3 Pipeline retry on the plan card only', () => {
    const failedExecution: RestrictedAgentExecution = {
      ...v3Execution,
      status: 'failed',
      error: { code: 'ASSERT_FAILED', message: '输出规格校验失败' },
      actions: v3Execution.actions?.map((action) => ({
        ...action,
        status: action.actionIndex === 2 ? 'failed' : action.status,
        error: action.actionIndex === 2 ? { code: 'ASSERT_FAILED', message: '输出规格校验失败' } : null,
      })),
    }
    const failedTask = task('pipeline-failed', {
      status: 'error',
      error: '输出规格校验失败',
      agentPlanSnapshot: v3Plan,
      agentExecutionSnapshot: failedExecution,
      agentExecutionId: failedExecution.id,
      agentRoute: 'tool_pipeline',
    })

    const markup = renderToStaticMarkup(
      <AgentMainWorkspace task={failedTask} conversationTasks={[failedTask]} />,
    )

    expect(markup).toContain('data-task-action-row="agent"')
    expect(markup.match(/aria-label="重试"/g)).toHaveLength(1)
    expect(markup).not.toContain('aria-label="重试任务"')
  })

  it('renders legacy v1/v2 Tool records read-only without confirmation controls', () => {
    const legacyTask = task('legacy-tool', {
      origin: 'restricted-agent',
      agentPlanSnapshot: legacyPlan,
      agentOriginalRequest: '读取旧版 Tool 结果',
    })

    const markup = renderToStaticMarkup(
      <AgentMainWorkspace task={legacyTask} conversationTasks={[legacyTask]} />,
    )

    expect(markup).toContain('旧版 Tool 计划')
    expect(markup).toContain('只读兼容')
    expect(markup).not.toMatch(/确认|返回修改/)
  })
})

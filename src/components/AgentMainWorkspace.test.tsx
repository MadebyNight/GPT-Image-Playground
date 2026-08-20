import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DEFAULT_PARAMS,
  type TaskRecord,
  type ToolAgentPlan,
} from '../types'

const mocks = vi.hoisted(() => ({
  restrictedState: {} as Record<string, unknown>,
  setLightboxImageId: vi.fn(),
}))

vi.mock('../restrictedAgentStore', () => ({
  useRestrictedAgentStore: <T,>(selector: (state: Record<string, unknown>) => T) => selector(mocks.restrictedState),
}))
vi.mock('../store', () => ({
  useStore: <T,>(selector: (state: Record<string, unknown>) => T) => selector({
    setLightboxImageId: mocks.setLightboxImageId,
  }),
  getComposerDraftSnapshot: vi.fn(() => ({ prompt: '规划中的用户请求' })),
  ensureImageThumbnailCached: vi.fn(() => Promise.resolve(undefined)),
  subscribeImageThumbnail: vi.fn(() => () => undefined),
}))
vi.mock('./LegacyAgentMainWorkspace', () => ({
  default: ({ task }: { task: TaskRecord | null }) => <div data-component="chat-main" data-task={task?.id ?? ''} />,
}))
vi.mock('./AgentPlanCard', () => ({
  default: ({ plan }: { plan: ToolAgentPlan }) => <div data-component="plan-card">{plan.summary}</div>,
}))
vi.mock('./TaskActionRow', () => ({
  default: ({ presentation }: { presentation: string }) => <div data-task-action-row={presentation}>任务操作</div>,
}))

import AgentMainWorkspace from './AgentMainWorkspace'

const plan: ToolAgentPlan = {
  schemaVersion: 2,
  composerSnapshotHash: 'a'.repeat(64),
  id: 'plan-1',
  version: 2,
  status: 'awaiting_confirmation',
  expiresAt: '2099-01-01T00:00:00.000Z',
  originalRequest: '生成一张蓝色产品海报',
  summary: '蓝色产品海报计划',
  operation: {
    type: 'image.generate',
    generation: {
      exactPrompt: '极简蓝色产品发布海报',
      action: 'generate',
      size: '1024x1024',
      quality: 'high',
      outputFormat: 'png',
      outputCompression: null,
      imageCount: 1,
    },
  },
  inputs: [],
  assumptions: [],
  warnings: [],
  policyVersion: 'policy-v2',
}

function task(id: string, origin: TaskRecord['origin'] = 'restricted-agent'): TaskRecord {
  return {
    id,
    prompt: `任务 Prompt ${id}`,
    params: { ...DEFAULT_PARAMS, size: '1024x1024', quality: 'high' },
    inputImageIds: ['reference-1'],
    outputImages: ['output-1', 'output-2'],
    rawImageUrls: ['https://example.com/output.png'],
    rawResponsePayload: '{"status":"completed"}',
    revisedPromptByImage: { 'output-1': '修订后的产品海报 Prompt' },
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    origin,
    agentOriginalRequest: '生成一张蓝色产品海报',
    agentPlanId: plan.id,
    agentExecutionId: 'execution-recorded',
    agentPlanSnapshot: plan,
  }
}

function resetRestrictedState(overrides: Record<string, unknown> = {}) {
  mocks.restrictedState = {
    phase: 'idle',
    plan: null,
    execution: null,
    taskId: null,
    error: null,
    assetBindings: [],
    localRun: null,
    planningText: '',
    retryOpenShopSave: vi.fn(),
    returnToEditing: vi.fn(),
    cancelExecution: vi.fn(),
    ...overrides,
  }
}

describe('AgentMainWorkspace', () => {
  beforeEach(() => {
    mocks.setLightboxImageId.mockReset()
    resetRestrictedState()
  })

  it('同时挂载 Chat 与 Tool，并用稳定 panel id 切换可见性', () => {
    const chatTask = task('chat-task', 'agent')
    const toolTask = task('tool-task')
    const markup = renderToStaticMarkup(
      <AgentMainWorkspace mode="tool" chatTask={chatTask} chatConversationTasks={[chatTask]} toolTask={toolTask} />,
    )

    expect(markup).toContain('id="agent-chat-panel"')
    expect(markup).toContain('id="agent-tool-panel"')
    expect(markup).toContain('data-agent-main-mode="chat"')
    expect(markup).toContain('data-agent-main-mode="tool"')
    expect(markup).toContain('data-component="chat-main"')
    expect(markup).toContain('data-task="chat-task"')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('aria-hidden="false"')
  })

  it('从旧 TaskRecord 恢复为共享消息流、160px 结果、动作行和折叠详情', () => {
    const completed = task('completed-task')
    const markup = renderToStaticMarkup(
      <AgentMainWorkspace mode="tool" chatTask={null} toolTask={completed} />,
    )

    expect(markup).toContain('data-agent-conversation-stream')
    expect(markup).toContain('data-agent-tool-user-message')
    expect(markup).toContain('justify-end')
    expect(markup).toContain('生成一张蓝色产品海报')
    expect(markup).toContain('data-agent-tool-response')
    expect(markup).toContain('data-agent-result-reply')
    expect(markup).toContain('data-agent-result-images')
    expect(markup).toContain('w-40')
    expect(markup).toContain('data-lightbox-image-list="output-1 output-2"')
    expect(markup).toContain('data-task-action-row="agent"')
    expect(markup).toContain('data-agent-execution-details')
    expect(markup).toContain('蓝色产品海报计划')
    expect(markup).toContain('policy-v2')
    expect(markup).toContain('execution-recorded')
    expect(markup).toContain('https://example.com/output.png')
    expect(markup).toContain('data-selectable-text')
    expect(markup).not.toContain('data-component="task-detail"')
  })

  it('idle 是非实时流程的权威状态，不让残留状态覆盖历史任务', () => {
    resetRestrictedState({ phase: 'idle', plan, error: '不应显示的残留错误' })
    const historical = task('historical-idle-task')

    const markup = renderToStaticMarkup(
      <AgentMainWorkspace mode="tool" chatTask={null} toolTask={historical} />,
    )

    expect(markup).toContain('execution-recorded')
    expect(markup).toContain('生成一张蓝色产品海报')
    expect(markup).not.toContain('不应显示的残留错误')
  })

  it('只把当前 task 对应的 live execution 叠加进消息，历史任务不会串入状态', () => {
    const livePlan = {
      ...plan,
      id: 'live-plan',
      originalRequest: '不应串入历史的实时请求',
      summary: '不应串入历史的实时计划',
    }
    resetRestrictedState({
      phase: 'executing',
      taskId: 'live-task',
      plan: livePlan,
      execution: {
        id: 'live-execution',
        planId: livePlan.id,
        status: 'executing',
        cancelRequested: false,
        error: null,
        outputAssets: [],
        createdAt: '2026-08-12T00:00:00.000Z',
        startedAt: '2026-08-12T00:00:01.000Z',
        completedAt: null,
        updatedAt: '2026-08-12T00:00:02.000Z',
      },
    })

    const historical = task('historical-task')
    const markup = renderToStaticMarkup(
      <AgentMainWorkspace mode="tool" chatTask={null} toolTask={historical} />,
    )

    expect(markup).toContain('execution-recorded')
    expect(markup).toContain('生成一张蓝色产品海报')
    expect(markup).toContain('蓝色产品海报计划')
    expect(markup).not.toContain('live-execution')
    expect(markup).not.toContain('不应串入历史的实时请求')
    expect(markup).not.toContain('不应串入历史的实时计划')
    expect(markup).not.toContain('Gateway 正在执行已确认计划')
    expect(markup).not.toContain('尝试取消')
  })

  it('未绑定 task 的 planning 在选中历史任务时覆盖旧消息并显示流式文本', () => {
    resetRestrictedState({ phase: 'planning', taskId: null, planningText: '正在梳理蓝色海报的构图。' })
    const historical = {
      ...task('historical-planning-task'),
      agentOriginalRequest: '不应显示的旧历史请求',
    }

    const markup = renderToStaticMarkup(
      <AgentMainWorkspace mode="tool" chatTask={null} toolTask={historical} />,
    )

    expect(markup).toContain('规划中的用户请求')
    expect(markup).toContain('正在梳理蓝色海报的构图。')
    expect(markup).not.toContain('不应显示的旧历史请求')
    expect(markup).not.toContain('任务完成')
    expect(markup).not.toContain('data-agent-result-images')
    expect(markup).not.toContain('data-task-action-row="agent"')
  })

  it('兼容中的 awaiting_confirmation 立即作为执行启动展示，不显示计划确认卡', () => {
    resetRestrictedState({ phase: 'awaiting_confirmation', taskId: null, plan, planningText: '规划完成，准备执行。' })
    const historical = {
      ...task('historical-confirmation-task'),
      agentOriginalRequest: '不应显示的旧确认历史请求',
    }

    const markup = renderToStaticMarkup(
      <AgentMainWorkspace mode="tool" chatTask={null} toolTask={historical} />,
    )

    expect(markup).toContain(plan.originalRequest)
    expect(markup).toContain('规划完成，准备执行。')
    expect(markup).toContain('正在启动执行')
    expect(markup).not.toContain('data-component="plan-card"')
    expect(markup).not.toContain('确认')
    expect(markup).not.toContain('不应显示的旧确认历史请求')
    expect(markup).not.toContain('任务完成')
    expect(markup).not.toContain('execution-recorded')
    expect(markup).not.toContain('data-task-action-row="agent"')
  })

  it('未绑定 task 的规划失败在选中历史任务时显示错误和恢复动作', () => {
    resetRestrictedState({ phase: 'failed', taskId: null, error: '新规划服务不可用' })
    const historical = {
      ...task('historical-failed-task'),
      agentOriginalRequest: '不应显示的旧失败历史请求',
    }

    const markup = renderToStaticMarkup(
      <AgentMainWorkspace mode="tool" chatTask={null} toolTask={historical} />,
    )

    expect(markup).toContain('规划中的用户请求')
    expect(markup).toContain('新规划服务不可用')
    expect(markup).toContain('返回修改')
    expect(markup).not.toContain('不应显示的旧失败历史请求')
    expect(markup).not.toContain('任务完成')
    expect(markup).not.toContain('data-agent-result-images')
    expect(markup).not.toContain('data-task-action-row="agent"')
  })

  it('流式规划文字在规划和执行中保留，且不提供确认控件', () => {
    const planningText = '我会先确定画面构图，再生成蓝色产品海报。'
    resetRestrictedState({ phase: 'planning', planningText })
    const planningMarkup = renderToStaticMarkup(
      <AgentMainWorkspace mode="tool" chatTask={null} toolTask={null} />,
    )
    expect(planningMarkup).toContain('data-agent-tool-response')
    expect(planningMarkup).toContain('data-agent-tool-user-message')
    expect(planningMarkup).toContain('规划中的用户请求')
    expect(planningMarkup).toContain(planningText)
    expect(planningMarkup).not.toContain('确认')

    resetRestrictedState({
      phase: 'executing',
      plan,
      planningText,
      taskId: 'live-task',
      execution: {
        id: 'execution-live',
        planId: plan.id,
        status: 'executing',
        cancelRequested: false,
        error: null,
        outputAssets: [],
        createdAt: '2026-08-12T00:00:00.000Z',
        startedAt: '2026-08-12T00:00:01.000Z',
        completedAt: null,
        updatedAt: '2026-08-12T00:00:02.000Z',
      },
    })
    const runningTask = { ...task('live-task'), status: 'running' as const, outputImages: [], finishedAt: null, elapsed: null }
    const executionMarkup = renderToStaticMarkup(
      <AgentMainWorkspace mode="tool" chatTask={null} toolTask={runningTask} />,
    )
    expect(executionMarkup).toContain('data-agent-tool-response')
    expect(executionMarkup).toContain(planningText)
    expect(executionMarkup).toContain('Gateway 正在执行计划')
    expect(executionMarkup).toContain('尝试取消')
    expect(executionMarkup).toContain('execution-live')
    expect(executionMarkup).not.toContain('确认')
  })

  it('OpenShop 导出等待保存时只直显重试保存，并将 Run 信息放入详情', () => {
    resetRestrictedState({
      phase: 'failed',
      plan,
      taskId: 'openshop-task',
      error: 'OpenShop 已导出结果等待重试保存',
      localRun: {
        id: 'local-run-1',
        taskId: 'openshop-task',
        status: 'exported',
        saveStatus: 'failed',
        error: { code: 'SAVE_FAILED', message: '保存服务暂时不可用', retryable: true },
      },
    })
    const exportedTask = {
      ...task('openshop-task'),
      status: 'error' as const,
      error: '保存服务暂时不可用',
      outputImages: [],
      agentLocalRunId: 'local-run-1',
      agentRunId: 'local-run-1',
      agentLocalRunStatus: 'exported' as const,
      agentLocalSaveStatus: 'failed' as const,
    }

    const markup = renderToStaticMarkup(
      <AgentMainWorkspace mode="tool" chatTask={null} toolTask={exportedTask} />,
    )

    expect(markup).toContain('OpenShop 已导出结果，等待保存')
    expect(markup).toContain('保存服务暂时不可用')
    expect(markup).toContain('仅重试保存')
    expect(markup).not.toContain('返回修改并重新规划')
    expect(markup).toContain('local-run-1')
    expect(markup).toContain('执行与 Run')
    expect(markup).toContain('data-openshop-local-run-status="exported"')
  })

  it('失败、取消、过期和 stale 的恢复动作保持直接可见', () => {
    resetRestrictedState({ phase: 'failed', error: '规划服务不可用', planningText: '此前已完成规划说明。' })
    const failedMarkup = renderToStaticMarkup(
      <AgentMainWorkspace mode="tool" chatTask={null} toolTask={null} />,
    )
    expect(failedMarkup).toContain('规划服务不可用')
    expect(failedMarkup).toContain('此前已完成规划说明。')
    expect(failedMarkup).toContain('返回修改')
    expect(failedMarkup).not.toContain('确认')

    resetRestrictedState({ phase: 'stale', plan, error: '输入已变化' })
    const staleMarkup = renderToStaticMarkup(
      <AgentMainWorkspace mode="tool" chatTask={null} toolTask={null} />,
    )
    expect(staleMarkup).toContain('输入已变化')
    expect(staleMarkup).toContain('data-component="plan-card"')
  })
})

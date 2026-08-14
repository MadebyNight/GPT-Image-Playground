import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentCapabilities, TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'

const tasks: TaskRecord[] = [
  {
    id: 'task-background',
    prompt: '后台严格尺寸任务',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: 2,
    finishedAt: null,
    elapsed: null,
    origin: 'agent',
    agentConversationId: 'conversation-a',
    agentTurn: 2,
  },
  {
    id: 'task-selected',
    prompt: '当前会话任务',
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
  },
]

vi.mock('../store', () => ({
  useStore: <T,>(selector: (state: { tasks: TaskRecord[] }) => T) => selector({ tasks }),
}))
vi.mock('./AgentHistoryPanel', () => ({
  default: ({ activeTaskId }: { activeTaskId: string | null }) => <div data-component="agent-history" data-active-task={activeTaskId ?? ''} />,
}))
vi.mock('./AgentMainWorkspace', () => ({
  default: ({ task, conversationTasks }: { task: TaskRecord | null; conversationTasks: TaskRecord[] }) => (
    <div
      data-component="agent-main"
      data-task={task?.id ?? ''}
      data-turns={conversationTasks.map((item) => item.id).join(' ')}
    />
  ),
}))
vi.mock('./AgentTemplateRail', () => ({
  default: () => <div data-component="agent-templates" />,
}))

import AgentWorkspace, { getInitialAgentTaskId, getNextAgentTaskIdAfterRemoval } from './AgentWorkspace'

const capabilities: AgentCapabilities = {
  agentUsable: true,
  responsesUsable: true,
  toolPipelineUsable: true,
  chatAllowed: true,
  chatConfigured: true,
  chatUsable: true,
  tool: true,
  openShopTool: false,
  defaultMode: 'chat',
  modeSwitching: false,
}

describe('AgentWorkspace', () => {
  it('renders one responsive Agent shell without Chat or Tool selectors', () => {
    const markup = renderToStaticMarkup(
      <AgentWorkspace
        capabilities={capabilities}
        activeTaskId="task-selected"
        onActiveTaskChange={vi.fn()}
      />,
    )

    expect(markup).toContain('data-agent-mobile-drawer-trigger="history"')
    expect(markup).toContain('data-agent-mobile-drawer-trigger="templates"')
    expect(markup).toContain('data-component="agent-history"')
    expect(markup).toContain('data-component="agent-main"')
    expect(markup).toContain('data-task="task-selected"')
    expect(markup).toContain('data-turns="task-selected task-background"')
    expect(markup).not.toContain('data-agent-mode-switcher')
    expect(markup).not.toContain('aria-label="Agent 模式"')
    expect(markup).not.toMatch(/>Chat</)
    expect(markup).not.toMatch(/>Tool</)
    expect(markup).toContain('grid-cols-[15rem_minmax(0,1fr)_3rem]')
  })

  it('renders the embedded composer in the single central workspace only while active', () => {
    const props = {
      capabilities,
      activeTaskId: 'task-selected',
      onActiveTaskChange: vi.fn(),
      composer: <div data-component="embedded-composer" />,
    }

    expect(renderToStaticMarkup(<AgentWorkspace {...props} />)).toContain('data-component="embedded-composer"')
    expect(renderToStaticMarkup(<AgentWorkspace {...props} active={false} />)).not.toContain('data-component="embedded-composer"')
  })

  it('blocks the whole Agent when Responses is unavailable even if the pipeline is enabled', () => {
    const markup = renderToStaticMarkup(
      <AgentWorkspace
        capabilities={{ ...capabilities, agentUsable: false, responsesUsable: false, toolPipelineUsable: true, chatUsable: false, tool: true, defaultMode: null }}
        activeTaskId={null}
        onActiveTaskChange={vi.fn()}
      />,
    )

    expect(markup).toContain('Agent 当前不可用')
    expect(markup).toContain('Responses 服务不可用')
    expect(markup).toContain('不会单独启用')
  })

  it('selects the adjacent task after the active task is removed', () => {
    expect(getNextAgentTaskIdAfterRemoval(['a', 'b', 'c'], ['b', 'c'], 'a')).toBe('b')
    expect(getNextAgentTaskIdAfterRemoval(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c')
    expect(getNextAgentTaskIdAfterRemoval(['a', 'b', 'c'], ['a', 'b'], 'c')).toBe('b')
    expect(getNextAgentTaskIdAfterRemoval(['a'], [], 'a')).toBeNull()
  })

  it('initializes the latest history only after the hidden workspace becomes active', () => {
    const taskIds = ['task-background', 'task-selected']

    expect(getInitialAgentTaskId(false, null, taskIds)).toBeNull()
    expect(getInitialAgentTaskId(true, null, taskIds)).toBe('task-background')
    expect(getInitialAgentTaskId(true, 'task-selected', taskIds)).toBe('task-selected')
    expect(getInitialAgentTaskId(true, 'removed-task', taskIds)).toBe('task-background')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'

const tasks: TaskRecord[] = [
  {
    id: 'task-new',
    prompt: '新任务',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: 2,
    finishedAt: null,
    elapsed: null,
    origin: 'restricted-agent',
  },
  {
    id: 'task-old',
    prompt: '旧任务',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    origin: 'agent',
  },
]

vi.mock('../store', () => ({
  useStore: <T,>(selector: (state: { tasks: TaskRecord[] }) => T) => selector({ tasks }),
}))
vi.mock('./AgentHistoryPanel', () => ({
  default: ({ mode, activeTaskId }: { mode: string; activeTaskId: string | null }) => <div data-component="agent-history" data-mode={mode} data-active-task={activeTaskId ?? ''} />,
}))
vi.mock('./AgentMainWorkspace', () => ({
  default: ({ mode, chatTask, toolTask }: { mode: string; chatTask: TaskRecord | null; toolTask: TaskRecord | null }) => (
    <div data-component="agent-main" data-mode={mode} data-chat-task={chatTask?.id ?? ''} data-tool-task={toolTask?.id ?? ''} />
  ),
}))
vi.mock('./AgentTemplateRail', () => ({
  default: () => <div data-component="agent-templates" />,
}))

import AgentWorkspace from './AgentWorkspace'
import { getNextAgentTaskIdAfterRemoval } from './AgentWorkspace'

describe('AgentWorkspace', () => {
  it('renders mobile segments and desktop three-column regions for the selected task', () => {
    const markup = renderToStaticMarkup(
      <AgentWorkspace
        mode="chat"
        capabilities={{ chatAllowed: true, chatConfigured: true, chatUsable: true, tool: true, openShopTool: false, defaultMode: 'chat', modeSwitching: true }}
        activeTaskByMode={{ chat: 'task-old', tool: 'task-new' }}
        onActiveTaskChange={vi.fn()}
        onModeChange={vi.fn()}
      />,
    )

    expect(markup).toContain('aria-label="Agent 工作台分段"')
    expect(markup).toContain('历史')
    expect(markup).toContain('工作区')
    expect(markup).toContain('模板')
    expect(markup).toContain('data-component="agent-history"')
    expect(markup).toContain('data-component="agent-main"')
    expect(markup).toContain('data-component="agent-templates"')
    expect(markup).toContain('aria-label="Agent 模式"')
    expect(markup).toContain('data-chat-task="task-old"')
    expect(markup).toContain('data-tool-task="task-new"')
    expect(markup).toContain('grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)_minmax(18rem,22rem)]')
    expect(markup).toContain('2xl:grid-cols-[minmax(22rem,26rem)_minmax(0,1fr)_minmax(19rem,23rem)]')
  })

  it('single-capability mode hides the switcher and does not expose unavailable mode', () => {
    const markup = renderToStaticMarkup(
      <AgentWorkspace
        mode="tool"
        capabilities={{ chatAllowed: true, chatConfigured: false, chatUsable: false, tool: true, openShopTool: false, defaultMode: 'tool', modeSwitching: false }}
        activeTaskByMode={{ chat: null, tool: 'task-new' }}
        onActiveTaskChange={vi.fn()}
        onModeChange={vi.fn()}
      />,
    )

    expect(markup).not.toContain('aria-label="Agent 模式"')
    expect(markup).toContain('data-mode="tool"')
  })

  it('selects the adjacent task after the active task is removed', () => {
    expect(getNextAgentTaskIdAfterRemoval(['a', 'b', 'c'], ['b', 'c'], 'a')).toBe('b')
    expect(getNextAgentTaskIdAfterRemoval(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c')
    expect(getNextAgentTaskIdAfterRemoval(['a', 'b', 'c'], ['a', 'b'], 'c')).toBe('b')
    expect(getNextAgentTaskIdAfterRemoval(['a'], [], 'a')).toBeNull()
  })
})

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
  it('renders the responsive shared shell with persisted desktop rails and mobile drawer triggers', () => {
    const markup = renderToStaticMarkup(
      <AgentWorkspace
        mode="chat"
        capabilities={{ chatAllowed: true, chatConfigured: true, chatUsable: true, tool: true, openShopTool: false, defaultMode: 'chat', modeSwitching: true }}
        activeTaskByMode={{ chat: 'task-old', tool: 'task-new' }}
        onActiveTaskChange={vi.fn()}
        onModeChange={vi.fn()}
      />,
    )

    expect(markup).toContain('data-agent-mobile-drawer-trigger="history"')
    expect(markup).toContain('data-agent-mobile-drawer-trigger="templates"')
    expect(markup).toContain('data-agent-desktop-mode-header="true"')
    expect(markup).toContain('data-agent-mode-switcher="true" class="inline-flex')
    expect(markup).not.toContain('data-agent-mode-switcher="true" class="absolute')
    expect(markup).toContain('data-component="agent-history"')
    expect(markup).toContain('data-component="agent-main"')
    expect(markup).toContain('aria-label="Agent 模式"')
    expect(markup).toContain('aria-controls="agent-chat-panel"')
    expect(markup).toContain('data-chat-task="task-old"')
    expect(markup).toContain('data-tool-task="task-new"')
    expect(markup).toContain('grid-cols-[15rem_minmax(0,1fr)_3rem]')
    expect(markup).toContain('data-agent-history-expanded="true"')
    expect(markup).toContain('data-agent-template-expanded="false"')
    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('aria-expanded="false"')
  })

  it('renders the embedded composer inside the central column only while active', () => {
    const props = {
      mode: 'chat' as const,
      capabilities: { chatAllowed: true, chatConfigured: true, chatUsable: true, tool: true, openShopTool: false, defaultMode: 'chat' as const, modeSwitching: true },
      activeTaskByMode: { chat: 'task-old', tool: 'task-new' },
      onActiveTaskChange: vi.fn(),
      onModeChange: vi.fn(),
      composer: <div data-component="embedded-composer" />,
    }

    expect(renderToStaticMarkup(<AgentWorkspace {...props} />)).toContain('data-component="embedded-composer"')
    expect(renderToStaticMarkup(<AgentWorkspace {...props} active={false} />)).not.toContain('data-component="embedded-composer"')
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

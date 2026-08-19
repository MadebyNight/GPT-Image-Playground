import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'

const task: TaskRecord = {
  id: 'task-a',
  prompt: '历史任务',
  params: { ...DEFAULT_PARAMS },
  inputImageIds: [],
  outputImages: [],
  status: 'done',
  error: null,
  createdAt: 1,
  finishedAt: 2,
  elapsed: 1,
  origin: 'agent',
}

let visibleTasks: TaskRecord[] = [task]

const capturedTaskCards: Array<{
  variant?: string
  selectionEnabled?: boolean
  isSelected?: boolean
  onClick: () => void
  onDelete?: () => void
}> = []
const setDetailTaskId = vi.fn()

vi.mock('../store', () => ({
  useStore: <T,>(selector: (state: {
    tasks: TaskRecord[]
    searchQuery: string
    filterStatus: 'all'
    filterFavorite: boolean
    setConfirmDialog: () => void
    setDetailTaskId: typeof setDetailTaskId
  }) => T) => selector({
    tasks: visibleTasks,
    searchQuery: '',
    filterStatus: 'all',
    filterFavorite: false,
    setConfirmDialog: vi.fn(),
    setDetailTaskId,
  }),
  reuseConfig: vi.fn(),
  editOutputs: vi.fn(),
  removeTask: vi.fn(),
}))

vi.mock('./SearchBar', () => ({ default: () => <div data-component="search-bar" /> }))
vi.mock('./TaskCard', () => ({
  default: (props: {
    variant?: string
    selectionEnabled?: boolean
    isSelected?: boolean
    onClick: () => void
  }) => {
    capturedTaskCards.push(props)
    return <article data-component="task-card" />
  },
}))

import AgentHistoryPanel from './AgentHistoryPanel'

afterEach(() => {
  capturedTaskCards.length = 0
  setDetailTaskId.mockClear()
  visibleTasks = [task]
})

describe('AgentHistoryPanel', () => {
  it('在传入新会话操作时展示新对话入口', () => {
    const markup = renderToStaticMarkup(
      <AgentHistoryPanel mode="chat" activeTaskId="task-a" onSelectTask={vi.fn()} onNewConversation={vi.fn()} />,
    )

    expect(markup).toContain('data-agent-new-conversation')
    expect(markup).toContain('新对话')
    expect(markup).toContain('data-agent-conversation-id="legacy-agent:task-a"')
  })

  it('Tool 模式只展示 restricted-agent Run，不聚合为 Chat 会话', () => {
    visibleTasks = [
      task,
      { ...task, id: 'tool-a', origin: 'restricted-agent', createdAt: 3, agentConversationId: 'shared-tool-context' },
      { ...task, id: 'tool-b', origin: 'restricted-agent', createdAt: 2, agentConversationId: 'shared-tool-context' },
      { ...task, id: 'gallery-a', origin: 'gallery', createdAt: 4 },
      { ...task, id: 'openshop-a', origin: 'openshop', createdAt: 5 },
    ]

    const markup = renderToStaticMarkup(
      <AgentHistoryPanel mode="tool" activeTaskId="tool-a" onSelectTask={vi.fn()} onNewConversation={vi.fn()} />,
    )

    expect(markup).not.toContain('data-agent-new-conversation')
    expect(markup).toContain('data-agent-run-id="tool-a"')
    expect(markup).toContain('data-agent-run-id="tool-b"')
    expect(markup).not.toContain('data-agent-conversation-id')
    expect(capturedTaskCards).toHaveLength(2)
  })

  it('Tool 模式直接展示每个本地 Run 的持久化状态 badge', () => {
    const statuses = [
      ['running', '执行中'],
      ['exported', '待保存'],
      ['interrupted', '已中断'],
      ['failed', '失败'],
      ['completed', '已完成'],
      ['expired', '已过期'],
    ] as const
    visibleTasks = statuses.map(([status], index) => ({
      ...task,
      id: `tool-${status}`,
      origin: 'restricted-agent',
      createdAt: statuses.length - index,
      agentConversationId: 'shared-tool-context',
      agentLocalRunStatus: status,
      agentLocalSaveStatus: status === 'completed' ? 'completed' : status === 'exported' ? 'failed' : 'not_started',
    }))

    const markup = renderToStaticMarkup(
      <AgentHistoryPanel mode="tool" activeTaskId="tool-running" onSelectTask={vi.fn()} />,
    )

    statuses.forEach(([status, label]) => {
      expect(markup).toContain(`data-agent-run-id="tool-${status}"`)
      expect(markup).toContain(`data-agent-local-run-status="${status}"`)
      expect(markup).toContain(label)
    })
    expect(markup).not.toContain('data-agent-conversation-id')
    expect(capturedTaskCards).toHaveLength(statuses.length)
  })

  it('Chat 模式排除 Tool、Gallery 和手工 OpenShop 记录', () => {
    visibleTasks = [
      task,
      { ...task, id: 'tool-a', origin: 'restricted-agent' },
      { ...task, id: 'gallery-a', origin: 'gallery' },
      { ...task, id: 'openshop-a', origin: 'openshop' },
    ]

    renderToStaticMarkup(
      <AgentHistoryPanel mode="chat" activeTaskId="task-a" onSelectTask={vi.fn()} />,
    )

    expect(capturedTaskCards).toHaveLength(1)
  })

  it('将同一会话聚合为一张历史卡片，并继续到最新一轮', () => {
    const first = {
      ...task,
      id: 'conversation-turn-1',
      prompt: '第一轮需求',
      createdAt: 1,
      agentConversationId: 'conversation-a',
      agentTurn: 1,
    }
    const latest = {
      ...task,
      id: 'conversation-turn-2',
      prompt: '第二轮需求',
      createdAt: 2,
      agentConversationId: 'conversation-a',
      agentTurn: 2,
    }
    visibleTasks = [first, latest]
    const onSelectTask = vi.fn()

    const markup = renderToStaticMarkup(
      <AgentHistoryPanel mode="chat" activeTaskId={first.id} onSelectTask={onSelectTask} />,
    )

    expect(markup).toContain('data-agent-conversation-id="conversation-a"')
    expect(markup).toContain('2 轮')
    expect(capturedTaskCards).toHaveLength(1)

    capturedTaskCards[0].onClick()
    expect(onSelectTask).toHaveBeenCalledWith(latest.id)
  })

  it('selects Agent task without opening the detail modal', () => {
    const onSelectTask = vi.fn()
    const markup = renderToStaticMarkup(
      <AgentHistoryPanel mode="chat" activeTaskId="task-a" onSelectTask={onSelectTask} />,
    )

    expect(markup).toContain('data-component="search-bar"')
    expect(capturedTaskCards).toHaveLength(1)
    expect(capturedTaskCards[0]).toMatchObject({
      variant: 'compact',
      selectionEnabled: false,
      isSelected: true,
    })
    expect(capturedTaskCards[0].onDelete).toBeUndefined()

    capturedTaskCards[0].onClick()

    expect(onSelectTask).toHaveBeenCalledWith('task-a')
    expect(setDetailTaskId).not.toHaveBeenCalled()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'

const task: TaskRecord = {
  id: 'response-turn-1',
  prompt: '先生成产品海报',
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
}

let visibleTasks: TaskRecord[] = [task]

const capturedTaskCards: Array<{
  variant?: string
  selectionEnabled?: boolean
  isSelected?: boolean
  onClick: () => void
}> = []

vi.mock('../store', () => ({
  useStore: <T,>(selector: (state: {
    tasks: TaskRecord[]
    searchQuery: string
    filterStatus: 'all'
    filterFavorite: boolean
  }) => T) => selector({
    tasks: visibleTasks,
    searchQuery: '',
    filterStatus: 'all',
    filterFavorite: false,
  }),
  reuseConfig: vi.fn(),
  editOutputs: vi.fn(),
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
  visibleTasks = [task]
})

describe('AgentHistoryPanel', () => {
  it('uses one conversation history and keeps the new conversation entry', () => {
    const markup = renderToStaticMarkup(
      <AgentHistoryPanel activeTaskId="response-turn-1" onSelectTask={vi.fn()} onNewConversation={vi.fn()} />,
    )

    expect(markup).toContain('data-agent-new-conversation')
    expect(markup).toContain('新对话')
    expect(markup).toContain('data-agent-conversation-id="conversation-a"')
    expect(markup).not.toMatch(/Chat|Tool/)
  })

  it('aggregates Responses and Gateway turns by conversation and continues from the latest turn', () => {
    const gatewayTurn: TaskRecord = {
      ...task,
      id: 'gateway-turn-2',
      prompt: '改成 870×220 横幅',
      createdAt: 2,
      agentTurn: 2,
      agentRoute: 'tool_pipeline',
    }
    visibleTasks = [task, gatewayTurn]
    const onSelectTask = vi.fn()

    const markup = renderToStaticMarkup(
      <AgentHistoryPanel activeTaskId={task.id} onSelectTask={onSelectTask} />,
    )

    expect(markup).toContain('data-agent-conversation-id="conversation-a"')
    expect(markup).toContain('2 轮')
    expect(capturedTaskCards).toHaveLength(1)
    capturedTaskCards[0].onClick()
    expect(onSelectTask).toHaveBeenCalledWith(gatewayTurn.id)
  })

  it('keeps old Tool and OpenShop records as isolated read-only compatibility conversations', () => {
    visibleTasks = [
      task,
      { ...task, id: 'legacy-tool', origin: 'restricted-agent', agentConversationId: 'must-not-merge', createdAt: 3 },
      { ...task, id: 'legacy-openshop', origin: 'openshop', agentConversationId: 'must-not-merge', createdAt: 4 },
      { ...task, id: 'gallery-task', origin: 'gallery', createdAt: 5 },
    ]

    const markup = renderToStaticMarkup(
      <AgentHistoryPanel activeTaskId="legacy-tool" onSelectTask={vi.fn()} />,
    )

    expect(markup).toContain('data-agent-conversation-id="conversation-a"')
    expect(markup).toContain('data-agent-conversation-id="legacy-restricted-agent:legacy-tool"')
    expect(markup).toContain('data-agent-conversation-id="legacy-openshop:legacy-openshop"')
    expect(markup).not.toContain('gallery-task')
    expect(capturedTaskCards).toHaveLength(3)
  })

  it('selects the active conversation without opening a detail modal', () => {
    const onSelectTask = vi.fn()
    const markup = renderToStaticMarkup(
      <AgentHistoryPanel activeTaskId="response-turn-1" onSelectTask={onSelectTask} />,
    )

    expect(markup).toContain('data-component="search-bar"')
    expect(capturedTaskCards).toHaveLength(1)
    expect(capturedTaskCards[0]).toMatchObject({
      variant: 'compact',
      selectionEnabled: false,
      isSelected: true,
    })
    capturedTaskCards[0].onClick()
    expect(onSelectTask).toHaveBeenCalledWith('response-turn-1')
  })
})

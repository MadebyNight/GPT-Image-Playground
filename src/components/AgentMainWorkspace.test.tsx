import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_PARAMS, type TaskRecord } from '../types'

vi.mock('../restrictedAgentStore', () => ({
  useRestrictedAgentStore: <T,>(selector: (state: Record<string, unknown>) => T) => selector({
    phase: 'idle',
    plan: null,
    execution: null,
    taskId: null,
    error: null,
    confirmAndExecute: vi.fn(),
    returnToEditing: vi.fn(),
    cancelExecution: vi.fn(),
  }),
}))
vi.mock('./LegacyAgentMainWorkspace', () => ({
  default: ({ task }: { task: TaskRecord | null }) => <div data-component="chat-main" data-task={task?.id ?? ''} />,
}))
vi.mock('./AgentPlanCard', () => ({ default: () => <div data-component="plan-card" /> }))
vi.mock('./TaskDetailContent', () => ({ default: () => <div data-component="task-detail" /> }))

import AgentMainWorkspace from './AgentMainWorkspace'

function task(id: string, origin: TaskRecord['origin']): TaskRecord {
  return {
    id,
    prompt: id,
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    origin,
  }
}

describe('AgentMainWorkspace', () => {
  it('keeps Chat and Tool workspaces mounted while only changing visibility', () => {
    const chatTask = task('chat-task', 'agent')
    const toolTask = task('tool-task', 'restricted-agent')
    const markup = renderToStaticMarkup(
      <AgentMainWorkspace mode="tool" chatTask={chatTask} chatConversationTasks={[chatTask]} toolTask={toolTask} />,
    )

    expect(markup).toContain('data-agent-main-mode="chat"')
    expect(markup).toContain('data-agent-main-mode="tool"')
    expect(markup).toContain('data-component="chat-main"')
    expect(markup).toContain('data-task="chat-task"')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('aria-hidden="false"')
  })
})

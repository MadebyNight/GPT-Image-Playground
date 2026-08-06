import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS, type TaskRecord } from '../types'
import {
  AGENT_CONTEXT_MAX_CHARACTERS,
  AGENT_CONTEXT_MAX_TURNS,
  buildAgentConversationContext,
  getAgentConversationId,
  getConversationTasks,
} from './agentConversation'

function task(
  id: string,
  conversationId: string | undefined,
  createdAt: number,
  prompt: string,
  assistantText: string,
): TaskRecord {
  return {
    id,
    prompt,
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt,
    finishedAt: createdAt + 1,
    elapsed: 1,
    origin: 'agent',
    agentConversationId: conversationId,
    agentTurn: createdAt,
    agentAssistantText: assistantText,
  }
}

describe('agentConversation', () => {
  it('只收集锚点所属会话的任务，不混入其他会话', () => {
    const first = task('a-1', 'conversation-a', 1, 'A 的第一轮请求', 'A 的第一轮回复')
    const second = task('a-2', 'conversation-a', 3, 'A 的第二轮请求', 'A 的第二轮回复')
    const other = task('b-1', 'conversation-b', 2, 'B 的请求', 'B 的回复')
    const allTasks = [first, other, second]

    expect(getAgentConversationId(second)).toBe('conversation-a')
    expect(getConversationTasks(allTasks, second).map((item) => item.id)).toEqual(['a-1', 'a-2'])
    expect(getConversationTasks(allTasks, 'conversation-b').map((item) => item.id)).toEqual(['b-1'])

    const context = buildAgentConversationContext(allTasks, 'conversation-a')
    expect(context).toContain('同一位用户的图像创作对话')
    expect(context).toContain('A 的第一轮请求')
    expect(context).toContain('A 的第二轮回复')
    expect(context).not.toContain('B 的请求')
    expect(context).not.toContain('B 的回复')
  })

  it('把没有会话字段的旧任务视为各自独立的会话', () => {
    const legacyA = task('legacy-a', undefined, 1, '旧任务 A', '旧任务 A 的回复')
    const legacyB = task('legacy-b', undefined, 2, '旧任务 B', '旧任务 B 的回复')

    expect(getAgentConversationId(legacyA)).toBe('legacy-agent:legacy-a')
    expect(getConversationTasks([legacyA, legacyB], legacyA).map((item) => item.id)).toEqual(['legacy-a'])

    const context = buildAgentConversationContext([legacyA, legacyB], getAgentConversationId(legacyA))
    expect(context).toContain('旧任务 A')
    expect(context).not.toContain('旧任务 B')
  })

  it('只保留最近有限轮次，并在截断时优先保留最新上下文', () => {
    const conversationId = 'conversation-limited'
    const turns = Array.from({ length: AGENT_CONTEXT_MAX_TURNS + 2 }, (_, index) => {
      const turn = index + 1
      return task(
        `limited-${turn}`,
        conversationId,
        turn,
        `请求-${turn}`,
        `回复-${turn}`,
      )
    })

    const context = buildAgentConversationContext(turns, conversationId)
    expect(context).toContain(`请求-${AGENT_CONTEXT_MAX_TURNS + 2}`)
    expect(context).toContain(`回复-${AGENT_CONTEXT_MAX_TURNS + 2}`)
    expect(context).not.toContain('请求-1')
    expect(context).not.toContain('回复-1')
  })

  it('将上下文限制在字符预算内，并保留最新一轮', () => {
    const conversationId = 'conversation-character-limit'
    const longText = '内容'.repeat(AGENT_CONTEXT_MAX_CHARACTERS)
    const oldest = task('long-1', conversationId, 1, `最早请求 ${longText}`, `最早回复 ${longText}`)
    const latest = task('long-2', conversationId, 2, `最新请求 ${longText}`, `最新回复 ${longText}`)

    const context = buildAgentConversationContext([oldest, latest], conversationId)
    expect(context).not.toBeNull()
    expect(context!.length).toBeLessThanOrEqual(AGENT_CONTEXT_MAX_CHARACTERS)
    expect(context).toContain('最新请求')
    expect(context).toContain('最新回复')
  })
})

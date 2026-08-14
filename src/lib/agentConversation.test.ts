import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS, type TaskRecord } from '../types'
import {
  AGENT_CONTEXT_MAX_CHARACTERS,
  AGENT_CONTEXT_MAX_TURNS,
  buildAgentConversationContext,
  filterAgentTasksByMode,
  getAgentModeForTask,
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

  it('优先按 agentTurn 排列消息，并为旧记录保留稳定时间顺序', () => {
    const conversationId = 'conversation-turn-order'
    const second = { ...task('turn-2', conversationId, 10, '第二轮', '第二轮回复'), agentTurn: 2 }
    const first = { ...task('turn-1', conversationId, 20, '第一轮', '第一轮回复'), agentTurn: 1 }
    const legacyA = { ...task('legacy-a', conversationId, 30, '旧记录 A', '旧回复 A'), agentTurn: undefined }
    const legacyB = { ...task('legacy-b', conversationId, 40, '旧记录 B', '旧回复 B'), agentTurn: undefined }

    expect(getConversationTasks([legacyB, second, legacyA, first], conversationId).map((item) => item.id)).toEqual([
      'turn-1',
      'turn-2',
      'legacy-a',
      'legacy-b',
    ])
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

  it('持久化失败轮次的 partial 文本，但不把它当作已完成上下文', () => {
    const conversationId = 'conversation-partial-error'
    const completed = task('done-1', conversationId, 1, '已完成请求', '已完成回复')
    const failedPartial = {
      ...task('error-2', conversationId, 2, '失败请求', '未完成的 partial 回复'),
      status: 'error' as const,
      error: '流式响应中断',
    }

    const context = buildAgentConversationContext([completed, failedPartial], conversationId)

    expect(context).toContain('已完成请求')
    expect(context).toContain('已完成回复')
    expect(context).not.toContain('失败请求')
    expect(context).not.toContain('未完成的 partial 回复')
  })

  it('按 origin 兼容映射 Chat、Tool，并排除 Gallery 与手工 OpenShop', () => {
    const chat = task('chat', 'conversation-chat', 1, 'Chat', '回复')
    const tool = { ...task('tool', undefined, 2, 'Tool', '完成'), origin: 'restricted-agent' as const }
    const gallery = { ...task('gallery', undefined, 3, 'Gallery', '完成'), origin: 'gallery' as const }
    const openShop = { ...task('openshop', undefined, 4, 'OpenShop', '完成'), origin: 'openshop' as const }

    expect(getAgentModeForTask(chat)).toBe('chat')
    expect(getAgentModeForTask(tool)).toBe('tool')
    expect(getAgentModeForTask(gallery)).toBeNull()
    expect(getAgentModeForTask(openShop)).toBeNull()
    expect(filterAgentTasksByMode([chat, tool, gallery, openShop], 'chat').map((item) => item.id)).toEqual(['chat'])
    expect(filterAgentTasksByMode([chat, tool, gallery, openShop], 'tool').map((item) => item.id)).toEqual(['tool'])
  })

  it('将新的 Responses 与 Gateway 回合按 agentConversationId 聚合', () => {
    const responses = {
      ...task('responses', 'unified-conversation', 1, '生成图片', '已生成'),
      agentTurn: 1,
      agentExecutionRoute: 'responses_image' as const,
    }
    const gateway = {
      ...task('gateway', 'unified-conversation', 2, '导出横幅', '已导出'),
      agentTurn: 2,
      agentExecutionId: 'execution-1',
      agentExecutionRoute: 'gateway_image_generate' as const,
    }

    expect(getConversationTasks([gateway, responses], 'unified-conversation').map((item) => item.id)).toEqual([
      'responses',
      'gateway',
    ])
  })

  it('为旧 Tool 与 OpenShop 记录建立各自隔离的兼容会话', () => {
    const legacyTool = {
      ...task('legacy-tool', 'incorrect-shared-id', 1, '旧 Tool', '完成'),
      origin: 'restricted-agent' as const,
    }
    const legacyOpenShop = {
      ...task('legacy-openshop', 'incorrect-shared-id', 2, '旧 OpenShop', '完成'),
      origin: 'openshop' as const,
    }

    expect(getAgentConversationId(legacyTool)).toBe('legacy-restricted-agent:legacy-tool')
    expect(getAgentConversationId(legacyOpenShop)).toBe('legacy-openshop:legacy-openshop')
    expect(getConversationTasks([legacyTool, legacyOpenShop], legacyTool).map((item) => item.id)).toEqual(['legacy-tool'])
    expect(getConversationTasks([legacyTool, legacyOpenShop], legacyOpenShop).map((item) => item.id)).toEqual(['legacy-openshop'])
  })
})

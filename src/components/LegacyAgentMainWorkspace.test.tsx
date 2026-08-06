import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_PARAMS, type TaskRecord } from '../types'
import LegacyAgentMainWorkspace from './LegacyAgentMainWorkspace'

function task(
  id: string,
  turn: number,
  prompt: string,
  assistantText: string,
): TaskRecord {
  return {
    id,
    prompt,
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [`image-${id}`],
    status: 'done',
    error: null,
    createdAt: turn,
    finishedAt: turn + 1,
    elapsed: 1,
    origin: 'agent',
    agentConversationId: 'conversation-a',
    agentTurn: turn,
    agentAssistantText: assistantText,
  }
}

describe('LegacyAgentMainWorkspace', () => {
  it('默认收敛展示最后回复与预览，将完整对话和执行详情折叠', () => {
    const first = task('turn-1', 1, '先生成一张海报', '第一轮回复')
    const latest = task('turn-2', 2, '把标题改成夏日新品', '第二轮最终回复')
    const markup = renderToStaticMarkup(
      <LegacyAgentMainWorkspace task={latest} conversationTasks={[first, latest]} />,
    )

    expect(markup).toContain('data-agent-latest-response')
    expect(markup).toContain('data-agent-image-preview')
    expect(markup).toContain('max-w-[42rem]')
    expect(markup).toContain('data-testid="agent-full-thread"')
    expect(markup).toContain('data-testid="agent-execution-details"')
    expect(markup).toContain('data-testid="agent-task-detail"')
    expect(markup).toContain('完整对话')
    expect(markup).toContain('执行详情')
    expect(markup.indexOf('第二轮最终回复')).toBeLessThan(markup.indexOf('data-testid="agent-full-thread"'))
    expect(markup.indexOf('第一轮回复')).toBeGreaterThan(markup.indexOf('data-testid="agent-full-thread"'))
    expect(markup).not.toMatch(/<details[^>]*data-testid="agent-full-thread"[^>]*\sopen(?:[=>\s])/)
    expect(markup).not.toMatch(/<details[^>]*data-testid="agent-execution-details"[^>]*\sopen(?:[=>\s])/)
    expect(markup).not.toMatch(/<details[^>]*data-testid="agent-task-detail"[^>]*\sopen(?:[=>\s])/)
  })
})

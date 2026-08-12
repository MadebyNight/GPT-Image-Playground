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
  it('按全部轮次自然渲染用户消息与 Agent 回复，不再保留旧大卡和任务详情', () => {
    const first = task('turn-1', 1, '先生成一张海报', '第一轮回复')
    const latest = task('turn-2', 2, '把标题改成夏日新品', '第二轮最终回复')
    const markup = renderToStaticMarkup(
      <LegacyAgentMainWorkspace task={latest} conversationTasks={[first, latest]} />,
    )

    expect(markup).toContain('data-agent-conversation-stream')
    expect(markup.match(/data-agent-user-message/g)).toHaveLength(2)
    expect(markup.match(/data-agent-result-reply/g)).toHaveLength(2)
    expect(markup.match(/data-selectable-text/g)).toHaveLength(4)
    expect(markup.indexOf('先生成一张海报')).toBeLessThan(markup.indexOf('第一轮回复'))
    expect(markup.indexOf('第一轮回复')).toBeLessThan(markup.indexOf('把标题改成夏日新品'))
    expect(markup.indexOf('把标题改成夏日新品')).toBeLessThan(markup.indexOf('第二轮最终回复'))
    expect(markup).not.toContain('data-agent-latest-response')
    expect(markup).not.toContain('完整对话')
    expect(markup).not.toContain('data-testid="agent-task-detail"')
  })

  it('最终多图使用 160px 缓存预览、完整 Lightbox 列表与 Agent 操作行', () => {
    const completed = {
      ...task('turn-images', 1, '生成两张候选图', '已生成两张候选图'),
      outputImages: ['image-a', 'image-b'],
      revisedPromptByImage: {
        'image-a': '蓝色极简海报',
        'image-b': '红色实验排版海报',
      },
    }

    const markup = renderToStaticMarkup(
      <LegacyAgentMainWorkspace task={completed} conversationTasks={[completed]} />,
    )

    expect(markup.match(/data-agent-image-preview/g)).toHaveLength(2)
    expect(markup).toContain('data-lightbox-image-list="image-a image-b"')
    expect(markup).toContain('max-width:10rem')
    expect(markup).toContain('data-task-action-row="agent"')
    expect(markup).toContain('执行详情')
    expect(markup).toContain('蓝色极简海报')
    expect(markup).toContain('红色实验排版海报')
    expect(markup).not.toMatch(/<details[^>]*data-agent-execution-details[^>]*\sopen(?:[=>\s])/)
    expect(markup.match(/data-image-id="image-a"/g)).toHaveLength(1)
    expect(markup.match(/data-image-id="image-b"/g)).toHaveLength(1)
  })

  it('无当前任务时仍挂载共享消息流并展示空状态', () => {
    const markup = renderToStaticMarkup(<LegacyAgentMainWorkspace task={null} />)

    expect(markup).toContain('data-agent-conversation-stream')
    expect(markup).toContain('输入提示词开始一段新的对话')
  })

  it('为运行中的 Chat 任务提供取消入口', () => {
    const running = {
      ...task('turn-running', 1, '生成中', ''),
      outputImages: [],
      status: 'running' as const,
      finishedAt: null,
      elapsed: null,
    }

    const markup = renderToStaticMarkup(<LegacyAgentMainWorkspace task={running} conversationTasks={[running]} />)

    expect(markup).toContain('data-agent-cancel-task="turn-running"')
    expect(markup).toContain('取消生成')
    expect(markup).toContain('data-preview-interactive="false"')
    expect(markup).toContain('等待图片输出')
  })

  it('失败任务同时展示已持久化 partial 与终止错误', () => {
    const failed = {
      ...task('turn-error', 1, '失败请求', '未完成 partial'),
      outputImages: [],
      status: 'error' as const,
      error: '流式响应中断',
    }

    const markup = renderToStaticMarkup(<LegacyAgentMainWorkspace task={failed} conversationTasks={[failed]} />)

    expect(markup).toContain('未完成 partial')
    expect(markup).toContain('data-agent-error-summary')
    expect(markup).toContain('流式响应中断')
  })
})

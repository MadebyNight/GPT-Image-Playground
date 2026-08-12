import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import AgentConversationStream, {
  AGENT_CONVERSATION_BOTTOM_THRESHOLD,
  isNearAgentConversationBottom,
} from './AgentConversationStream'

describe('isNearAgentConversationBottom', () => {
  it('把阈值内和阈值边界视为接近底部', () => {
    expect(isNearAgentConversationBottom({
      scrollTop: 305,
      scrollHeight: 1000,
      clientHeight: 600,
    })).toBe(true)
    expect(isNearAgentConversationBottom({
      scrollTop: 400 - AGENT_CONVERSATION_BOTTOM_THRESHOLD,
      scrollHeight: 1000,
      clientHeight: 600,
    })).toBe(true)
  })

  it('用户上滚超过阈值后停止跟随', () => {
    expect(isNearAgentConversationBottom({
      scrollTop: 400 - AGENT_CONVERSATION_BOTTOM_THRESHOLD - 1,
      scrollHeight: 1000,
      clientHeight: 600,
    })).toBe(false)
  })

  it('允许调用方覆盖阈值', () => {
    expect(isNearAgentConversationBottom({
      scrollTop: 340,
      scrollHeight: 1000,
      clientHeight: 600,
    }, 64)).toBe(true)
    expect(isNearAgentConversationBottom({
      scrollTop: 335,
      scrollHeight: 1000,
      clientHeight: 600,
    }, 64)).toBe(false)
  })
})

describe('AgentConversationStream', () => {
  it('提供独立滚动区和限定宽度的自然消息列', () => {
    const markup = renderToStaticMarkup(
      <AgentConversationStream
        conversationKey="conversation-1"
        contentVersion={2}
        className="custom-stream"
      >
        <article>第一条消息</article>
        <article>第二条消息</article>
      </AgentConversationStream>,
    )

    expect(markup).toContain('data-agent-conversation-stream')
    expect(markup).toContain('custom-stream')
    expect(markup).toContain('data-agent-conversation-scroll-region')
    expect(markup).toContain('overflow-y-auto')
    expect(markup).toContain('role="region"')
    expect(markup).toContain('aria-label="对话消息"')
    expect(markup).toContain('tabindex="0"')
    expect(markup).toContain('max-w-[760px]')
    expect(markup).toContain('px-[clamp(16px,5vw,72px)]')
    expect(markup.indexOf('第一条消息')).toBeLessThan(markup.indexOf('第二条消息'))
  })

  it('没有消息时渲染空状态，有消息时不重复空状态', () => {
    const emptyMarkup = renderToStaticMarkup(
      <AgentConversationStream emptyState={<p>选择历史记录开始查看</p>} />,
    )
    const populatedMarkup = renderToStaticMarkup(
      <AgentConversationStream emptyState={<p>选择历史记录开始查看</p>}>
        <p>已有消息</p>
      </AgentConversationStream>,
    )

    expect(emptyMarkup).toContain('选择历史记录开始查看')
    expect(populatedMarkup).toContain('已有消息')
    expect(populatedMarkup).not.toContain('选择历史记录开始查看')
  })

  it('把常见的空消息数组视为空状态', () => {
    const messages: Array<React.ReactNode> = []
    const markup = renderToStaticMarkup(
      <AgentConversationStream emptyState={<p>暂无消息</p>}>
        {messages}
      </AgentConversationStream>,
    )

    expect(markup).toContain('暂无消息')
  })

  it('提供默认隐藏且可访问的回到底部按钮', () => {
    const markup = renderToStaticMarkup(
      <AgentConversationStream>
        <p>一条消息</p>
      </AgentConversationStream>,
    )

    expect(markup).toContain('data-agent-conversation-return-to-bottom')
    expect(markup).toContain('aria-label="回到底部"')
    expect(markup).toContain('title="回到底部"')
    expect(markup).toMatch(/<button[^>]*hidden=""/)
    expect(markup).toContain('lucide-arrow-down')
    expect(markup).toContain('回到底部</button>')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AgentResultReply from './AgentResultReply'

describe('AgentResultReply', () => {
  it('按自然文本、紧凑状态、多图缩略图和任务操作顺序组织回复', () => {
    const markup = renderToStaticMarkup(
      <AgentResultReply
        assistantText="已完成两张候选图。"
        status={{ label: '生成完成', detail: '耗时 12 秒', tone: 'success' }}
        images={[
          { id: 'image-1', alt: '候选图 1' },
          { id: 'image-2', alt: '候选图 2' },
        ]}
        onOpenImage={vi.fn()}
        taskActionRow={<button type="button">编辑输出</button>}
        executionDetails={<details><summary>执行详情</summary></details>}
      />,
    )

    expect(markup).toContain('data-agent-result-reply')
    expect(markup).toContain('已完成两张候选图。')
    expect(markup).toContain('生成完成')
    expect(markup).toContain('耗时 12 秒')
    expect(markup).toContain('data-agent-result-images')
    expect(markup).toContain('flex-wrap')
    expect(markup.match(/data-agent-image-preview/g)).toHaveLength(2)
    expect(markup).toContain('data-agent-task-action-row')
    expect(markup).toContain('编辑输出')
    expect(markup.indexOf('data-agent-result-images')).toBeLessThan(markup.indexOf('data-agent-task-action-row'))
    expect(markup.indexOf('data-agent-task-action-row')).toBeLessThan(markup.indexOf('执行详情'))
  })

  it('直接显示错误摘要和恢复动作，不把它们藏进执行详情', () => {
    const markup = renderToStaticMarkup(
      <AgentResultReply
        assistantText="失败前保留的 partial 文本"
        status={{ label: '生成失败', tone: 'error' }}
        errorMessage="流式响应中断"
        recoveryActions={<button type="button">重试保存</button>}
        executionDetails={<details><summary>执行详情</summary><p>原始响应</p></details>}
      />,
    )

    expect(markup).toContain('失败前保留的 partial 文本')
    expect(markup).toContain('data-agent-error-summary')
    expect(markup).toContain('流式响应中断')
    expect(markup).toContain('data-agent-recovery-actions')
    expect(markup).toContain('重试保存')
    expect(markup.indexOf('流式响应中断')).toBeLessThan(markup.indexOf('执行详情'))
    expect(markup.indexOf('重试保存')).toBeLessThan(markup.indexOf('执行详情'))
  })

  it('允许流式预览保持非交互', () => {
    const markup = renderToStaticMarkup(
      <AgentResultReply
        status={{ label: '生成中', tone: 'progress' }}
        images={[{
          fallbackSrc: 'data:image/png;base64,partial',
          alt: '生成中的预览',
          interactive: false,
        }]}
      />,
    )

    expect(markup).toContain('data:image/png;base64,partial')
    expect(markup).not.toContain('<button')
  })
})

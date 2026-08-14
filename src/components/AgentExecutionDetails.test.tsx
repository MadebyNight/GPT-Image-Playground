import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AgentExecutionDetails from './AgentExecutionDetails'

describe('AgentExecutionDetails', () => {
  it('默认关闭并按命名区域承载执行信息', () => {
    const markup = renderToStaticMarkup(
      <AgentExecutionDetails
        prompt="生成一张海报"
        revisedPrompt="生成一张极简蓝色产品海报"
        references={<span>参考图 A</span>}
        parameters={<span>1024×1024 · high</span>}
        plan={<span>计划摘要 · plan-1</span>}
        run={<span>execution-1 · local-run-1</span>}
        actionProgress={<span>图片生成 · 严格尺寸处理 · 输出规格校验</span>}
        partialPreviews={<span>中间预览 1</span>}
        rawImageUrls={['https://example.com/a.png']}
        rawResponse={'{"status":"completed"}'}
      />,
    )

    expect(markup).toContain('data-agent-execution-details')
    expect(markup).toContain('<summary')
    expect(markup).toContain('执行详情')
    expect(markup).not.toMatch(/<details[^>]*\sopen(?:[=>\s])/)
    expect(markup).toContain('用户 Prompt')
    expect(markup).toContain('修订 Prompt')
    expect(markup).toContain('参考图')
    expect(markup).toContain('参数与来源')
    expect(markup).toContain('计划')
    expect(markup).toContain('执行与 Run')
    expect(markup).toContain('执行进度')
    expect(markup).toContain('图片生成')
    expect(markup).toContain('严格尺寸处理')
    expect(markup).toContain('输出规格校验')
    expect(markup).toContain('流式中间预览')
    expect(markup).toContain('原始图片链接')
    expect(markup).toContain('原始响应')
    expect(markup).toContain('&quot;status&quot;:&quot;completed&quot;')
    expect(markup).not.toContain('image.generate')
  })

  it('只渲染有内容的详情区，API 不提供最终输出和任务动作插槽', () => {
    const markup = renderToStaticMarkup(
      <AgentExecutionDetails prompt="仅有 Prompt" />,
    )

    expect(markup).toContain('仅有 Prompt')
    expect(markup).not.toContain('修订 Prompt')
    expect(markup).not.toContain('最终输出')
    expect(markup).not.toContain('任务操作')
  })

  it('仅在显式要求时默认展开', () => {
    const markup = renderToStaticMarkup(
      <AgentExecutionDetails defaultOpen prompt="调试 Prompt" />,
    )

    expect(markup).toMatch(/<details[^>]*\sopen=""/)
  })
})

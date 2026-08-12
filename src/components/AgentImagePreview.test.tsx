import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AgentImagePreview from './AgentImagePreview'

describe('AgentImagePreview', () => {
  it('将流式 fallback 限制在 160px 内并保持完整比例', () => {
    const markup = renderToStaticMarkup(
      <AgentImagePreview fallbackSrc="data:image/png;base64,partial" alt="流式预览" interactive={false} />,
    )

    expect(markup).toContain('data-agent-image-preview')
    expect(markup).toContain('src="data:image/png;base64,partial"')
    expect(markup).toContain('object-contain')
    expect(markup).toContain('aspect-square')
    expect(markup).toContain('w-40')
    expect(markup).toContain('max-h-40')
    expect(markup).toContain('max-w-full')
    expect(markup).not.toContain('<button')
  })

  it('使用原生按钮提供点击、Enter 与 Space 语义，并声明完整 Lightbox 列表', () => {
    const markup = renderToStaticMarkup(
      <AgentImagePreview
        imageId="image-2"
        imageIds={['image-1', 'image-2', 'image-3']}
        alt="结果图 2"
        onOpen={vi.fn()}
      />,
    )

    expect(markup).toContain('<button')
    expect(markup).toContain('type="button"')
    expect(markup).toContain('aria-label="查看结果图 2"')
    expect(markup).toContain('data-image-id="image-2"')
    expect(markup).toContain('data-lightbox-image-list="image-1 image-2 image-3"')
    expect(markup).toContain('正在准备预览')
  })

  it('提供稳定的加载与错误占位，不让流式预览变成交互入口', () => {
    const loadingMarkup = renderToStaticMarkup(
      <AgentImagePreview alt="等待结果" previewState="loading" interactive={false} />,
    )
    const errorMarkup = renderToStaticMarkup(
      <AgentImagePreview alt="失败结果" previewState="error" interactive={false} />,
    )

    expect(loadingMarkup).toContain('data-preview-state="loading"')
    expect(loadingMarkup).toContain('等待图片输出')
    expect(errorMarkup).toContain('data-preview-state="error"')
    expect(errorMarkup).toContain('预览加载失败')
    expect(errorMarkup).not.toContain('<button')
  })
})

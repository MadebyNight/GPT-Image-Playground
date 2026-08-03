import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import OpenShopWorkspace from './OpenShopWorkspace'

describe('OpenShopWorkspace', () => {
  it('renders a full-page editor workspace with explicit history saving', () => {
    const markup = renderToStaticMarkup(
      <OpenShopWorkspace
        imageId="image-1"
        taskId="task-1"
        sourceDataUrl="data:image/png;base64,AA=="
        onClose={() => undefined}
        editor={<div data-editor-placeholder />}
      />,
    )

    expect(markup).toContain('data-openshop-workspace')
    expect(markup).toContain('data-image-id="image-1"')
    expect(markup).toContain('data-task-id="task-1"')
    expect(markup).toContain('保存到历史')
    expect(markup).toContain('返回画廊')
  })
})

import { describe, expect, it } from 'vitest'
import { routeAgentTurn } from './agentRoute'

describe('routeAgentTurn', () => {
  it('将精确像素尺寸锁定到 Tool Pipeline，并默认 cover + center', () => {
    expect(routeAgentTurn({ prompt: '生成一张 870×220 px 的夏日咖啡横幅' })).toMatchObject({
      route: 'tool_pipeline',
      fallbackForbidden: true,
      finalOutputSpec: { width: 870, height: 220, fit: 'cover', position: 'center' },
    })
  })

  it('识别 x 分隔的尺寸与严格比例', () => {
    expect(routeAgentTurn({ prompt: '导出为 1200 x 628 px' })).toMatchObject({
      route: 'tool_pipeline',
      finalOutputSpec: { width: 1200, height: 628, fit: 'cover', position: 'center' },
    })

    expect(routeAgentTurn({ prompt: '按严格 16:9 比例生成图片' })).toMatchObject({
      route: 'tool_pipeline',
      fallbackForbidden: true,
      hardConstraints: expect.arrayContaining(['固定比例 16:9']),
    })
  })

  it('将裁剪、旋转、翻转和缩放识别为确定性编辑', () => {
    expect(routeAgentTurn({ prompt: '裁剪这张图到主体区域', hasExplicitImageInput: true })).toMatchObject({
      route: 'tool_pipeline',
      fallbackForbidden: true,
      hardConstraints: expect.arrayContaining(['裁剪']),
    })

    expect(routeAgentTurn({ prompt: '把这张图顺时针旋转 90 度', hasExplicitImageInput: true })).toMatchObject({
      route: 'tool_pipeline',
      finalOutputSpec: { rotate: 90 },
    })

    expect(routeAgentTurn({ prompt: '将图片水平翻转', hasExplicitImageInput: true })).toMatchObject({
      route: 'tool_pipeline',
      finalOutputSpec: { flip: 'horizontal' },
    })

    expect(routeAgentTurn({ prompt: '将图片缩放到 50%', hasExplicitImageInput: true })).toMatchObject({
      route: 'tool_pipeline',
      fallbackForbidden: true,
      hardConstraints: expect.arrayContaining(['缩放']),
    })
  })

  it('提取格式、透明和压缩规格', () => {
    expect(routeAgentTurn({ prompt: '导出透明背景的 PNG，压缩质量 80' })).toMatchObject({
      route: 'tool_pipeline',
      finalOutputSpec: { outputFormat: 'png', transparent: true, outputCompression: 80 },
    })

    expect(routeAgentTurn({ prompt: '请保存为 WebP 格式' })).toMatchObject({
      route: 'tool_pipeline',
      finalOutputSpec: { outputFormat: 'webp' },
    })
  })

  it('将明确工具要求锁定到 Tool Pipeline', () => {
    expect(routeAgentTurn({ prompt: '请用 Tool Pipeline 完成这张图' })).toMatchObject({
      route: 'tool_pipeline',
      fallbackForbidden: true,
      hardConstraints: expect.arrayContaining(['明确要求 Tool Pipeline']),
    })
  })

  it('未绑定的历史图片指代会要求澄清，显式绑定则可执行', () => {
    expect(routeAgentTurn({ prompt: '编辑上一张图' })).toMatchObject({
      route: 'clarify',
      fallbackForbidden: true,
    })

    expect(routeAgentTurn({ prompt: '把刚才的图旋转 90 度 @图1' })).toMatchObject({
      route: 'tool_pipeline',
      finalOutputSpec: { rotate: 90 },
    })

    expect(routeAgentTurn({ prompt: '把上一张图旋转 90 度 @图片' })).toMatchObject({
      route: 'tool_pipeline',
      finalOutputSpec: { rotate: 90 },
    })
  })

  it('不裁切和允许变形会覆盖默认的尺寸适配策略', () => {
    expect(routeAgentTurn({ prompt: '生成 870×220 图片，不裁切' })).toMatchObject({
      route: 'tool_pipeline',
      finalOutputSpec: { width: 870, height: 220, fit: 'contain', position: 'center' },
    })

    expect(routeAgentTurn({ prompt: '生成 870×220 图片，允许变形' })).toMatchObject({
      route: 'tool_pipeline',
      finalOutputSpec: { width: 870, height: 220, fit: 'fill', position: 'center' },
    })
  })

  it('无硬约束的参考图语义编辑交给 Responses', () => {
    expect(routeAgentTurn({ prompt: '把天空改成黄昏', hasExplicitImageInput: true })).toMatchObject({
      route: 'responses_image',
      fallbackForbidden: false,
      finalOutputSpec: null,
    })
  })

  it('拒绝透明 JPEG 冲突', () => {
    expect(routeAgentTurn({ prompt: '输出透明背景 JPEG' })).toMatchObject({
      route: 'clarify',
      fallbackForbidden: true,
      hardConstraints: expect.arrayContaining(['透明背景', 'JPEG 格式']),
    })
  })
})

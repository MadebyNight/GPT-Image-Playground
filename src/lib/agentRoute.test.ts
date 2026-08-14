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

    expect(routeAgentTurn({ prompt: '生成一张透明图片' })).toMatchObject({
      route: 'tool_pipeline',
      hardConstraints: expect.arrayContaining(['透明背景']),
    })

    expect(routeAgentTurn({ prompt: '生成 GIF 格式图片' })).toMatchObject({
      route: 'unsupported',
      fallbackForbidden: true,
    })
  })

  it('将严格语境中的非常见比例锁定到 Tool Pipeline', () => {
    expect(routeAgentTurn({ prompt: '严格按照 2.35:1 生成电影感横幅' })).toMatchObject({
      route: 'tool_pipeline',
      fallbackForbidden: true,
      hardConstraints: expect.arrayContaining(['固定比例 2.35:1']),
    })
  })

  it('将明确工具要求锁定到 Tool Pipeline', () => {
    expect(routeAgentTurn({ prompt: '请用 Tool Pipeline 完成这张图' })).toMatchObject({
      route: 'tool_pipeline',
      fallbackForbidden: true,
      hardConstraints: expect.arrayContaining(['明确要求 Tool Pipeline']),
    })
  })

  it.each([
    '请用 Photoshop 完成这张图',
    '使用 Gimp 编辑这张图片',
    '请使用 Figma 制作这个横幅',
    '用 Canva 生成社交媒体配图',
    '请用美图秀秀处理这张照片',
  ])('将具名工具要求锁定到 Tool Pipeline：%s', (prompt) => {
    expect(routeAgentTurn({ prompt })).toMatchObject({
      route: 'tool_pipeline',
      fallbackForbidden: true,
      hardConstraints: expect.arrayContaining(['明确要求工具']),
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

  it('不会把画面语义误判为确定性编辑', () => {
    expect(routeAgentTurn({ prompt: '生成一幅有透明玻璃、旋转木马和放大镜的插画' })).toMatchObject({
      route: 'responses_image',
      fallbackForbidden: false,
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

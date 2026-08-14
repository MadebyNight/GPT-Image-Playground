import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ImageDownloadAnchor,
  ImageDownloadDependencies,
  ImageDownloadDocument,
  ImageDownloadResponse,
  ImageDownloadUrlApi,
} from './imageDownload'

const storeMocks = vi.hoisted(() => ({
  ensureImageCached: vi.fn(),
}))

vi.mock('../store', () => ({
  ensureImageCached: storeMocks.ensureImageCached,
}))

import { downloadImageSource, downloadOriginalImage } from './imageDownload'

function createDownloadDependencies(blob: Blob) {
  const events: string[] = []
  const anchor: ImageDownloadAnchor = {
    href: '',
    download: '',
    click: vi.fn(() => events.push('click')),
  }
  const response: ImageDownloadResponse = {
    ok: true,
    status: 200,
    blob: vi.fn(async () => blob),
  }
  const fetch = vi.fn(async (source: string) => response)
  const document: ImageDownloadDocument = {
    createElement: vi.fn(() => anchor),
    body: {
      appendChild: vi.fn(() => events.push('append')),
      removeChild: vi.fn(() => events.push('remove')),
    },
  }
  const url: ImageDownloadUrlApi = {
    createObjectURL: vi.fn(() => {
      events.push('create')
      return 'blob:original-image'
    }),
    revokeObjectURL: vi.fn(() => events.push('revoke')),
  }
  const dependencies: ImageDownloadDependencies = {
    fetch,
    document,
    url,
    now: () => 1_700_000_000_000,
  }

  return { anchor, dependencies, events, fetch, response, url }
}

describe('imageDownload', () => {
  beforeEach(() => {
    storeMocks.ensureImageCached.mockReset()
  })

  it('原图不存在时中止下载，不使用任何预览图兜底', async () => {
    storeMocks.ensureImageCached.mockResolvedValue(undefined)

    await expect(downloadOriginalImage('image-a')).rejects.toThrow('未找到原图')

    expect(storeMocks.ensureImageCached).toHaveBeenCalledWith('image-a')
  })

  it('从 IndexedDB 返回的完整 data URL 读取 Blob，而不是缩略图 source', async () => {
    const originalSource = 'data:image/png;base64,b3JpZ2luYWw='
    const fixture = createDownloadDependencies(new Blob(['original'], { type: 'image/png' }))
    storeMocks.ensureImageCached.mockResolvedValue(originalSource)

    await downloadOriginalImage('image-a', fixture.dependencies)

    expect(storeMocks.ensureImageCached).toHaveBeenCalledWith('image-a')
    expect(fixture.fetch).toHaveBeenCalledWith(originalSource)
    expect(fixture.anchor.href).toBe('blob:original-image')
    expect(fixture.anchor.download).toBe('image-1700000000000.png')
  })

  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
    ['image/avif', 'avif'],
    ['image/svg+xml', 'svg'],
    ['image/tiff', 'tiff'],
    ['', 'png'],
    ['application/octet-stream', 'png'],
    ['image/foo/bar', 'png'],
  ])('按 MIME %s 生成 .%s 文件名', async (mimeType, extension) => {
    const fixture = createDownloadDependencies(new Blob(['image'], { type: mimeType }))

    await downloadImageSource('data:image/mock;base64,aW1hZ2U=', fixture.dependencies)

    expect(fixture.anchor.download).toBe(`image-1700000000000.${extension}`)
  })

  it('完成点击后移除 anchor 并回收 object URL', async () => {
    const fixture = createDownloadDependencies(new Blob(['image'], { type: 'image/webp' }))

    await downloadImageSource('data:image/webp;base64,aW1hZ2U=', fixture.dependencies)

    expect(fixture.events).toEqual(['create', 'append', 'click', 'remove', 'revoke'])
    expect(fixture.url.revokeObjectURL).toHaveBeenCalledWith('blob:original-image')
  })
})

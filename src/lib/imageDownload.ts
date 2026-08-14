import { ensureImageCached } from '../store'

const extensionByMimeType: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
}

export interface ImageDownloadResponse {
  ok: boolean
  status: number
  blob: () => Promise<Blob>
}

export interface ImageDownloadAnchor {
  href: string
  download: string
  click: () => void
}

export interface ImageDownloadDocument {
  createElement: (tagName: 'a') => ImageDownloadAnchor
  body: {
    appendChild: (anchor: ImageDownloadAnchor) => unknown
    removeChild: (anchor: ImageDownloadAnchor) => unknown
  }
}

export interface ImageDownloadUrlApi {
  createObjectURL: (blob: Blob) => string
  revokeObjectURL: (url: string) => void
}

export interface ImageDownloadDependencies {
  getOriginalImage?: (imageId: string) => Promise<string | undefined>
  fetch?: (source: string) => Promise<ImageDownloadResponse>
  document?: ImageDownloadDocument
  url?: ImageDownloadUrlApi
  now?: () => number
}

export function getImageDownloadFilename(blob: Blob, now: () => number = Date.now) {
  const mimeType = blob.type.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  const knownExtension = extensionByMimeType[mimeType]
  const imageSubtype = /^image\/([a-z0-9][a-z0-9.+_-]*)$/.exec(mimeType)?.[1]
  const extension = knownExtension ?? imageSubtype ?? 'png'
  return `image-${now()}.${extension}`
}

function getBrowserDocument(): ImageDownloadDocument {
  return {
    createElement: () => document.createElement('a'),
    body: {
      appendChild: (anchor) => document.body.appendChild(anchor as HTMLAnchorElement),
      removeChild: (anchor) => document.body.removeChild(anchor as HTMLAnchorElement),
    },
  }
}

function getBrowserUrlApi(): ImageDownloadUrlApi {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  }
}

/**
 * 下载指定 data URL 对应的原始二进制，不经 Canvas 或任何图片重编码。
 */
export async function downloadImageSource(source: string, dependencies: ImageDownloadDependencies = {}) {
  const fetchImage = dependencies.fetch ?? ((dataUrl: string) => globalThis.fetch(dataUrl))
  const response = await fetchImage(source)
  if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`)

  const blob = await response.blob()
  const documentApi = dependencies.document ?? getBrowserDocument()
  const urlApi = dependencies.url ?? getBrowserUrlApi()
  const anchor = documentApi.createElement('a')
  const objectUrl = urlApi.createObjectURL(blob)
  let appended = false

  anchor.href = objectUrl
  anchor.download = getImageDownloadFilename(blob, dependencies.now)
  try {
    documentApi.body.appendChild(anchor)
    appended = true
    anchor.click()
  } finally {
    try {
      if (appended) documentApi.body.removeChild(anchor)
    } finally {
      urlApi.revokeObjectURL(objectUrl)
    }
  }
}

/**
 * 通过图片 ID 读取 IndexedDB 中保存的完整原图后下载。
 */
export async function downloadOriginalImage(imageId: string, dependencies: ImageDownloadDependencies = {}) {
  if (!imageId) throw new Error('缺少图片标识')

  const source = await (dependencies.getOriginalImage ?? ensureImageCached)(imageId)
  if (!source) throw new Error('未找到原图，它可能已被清理或不在当前浏览器中。')

  await downloadImageSource(source, dependencies)
}

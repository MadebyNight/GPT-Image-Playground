import { useEffect, useState } from 'react'
import { ensureImageThumbnailCached, subscribeImageThumbnail } from '../store'

export type AgentImagePreviewState = 'loading' | 'error'

export interface AgentImagePreviewProps {
  imageId?: string
  imageIds?: readonly string[]
  fallbackSrc?: string
  alt: string
  className?: string
  interactive?: boolean
  previewState?: AgentImagePreviewState
  onOpen?: (imageId: string, imageIds: string[]) => void
}

/**
 * Agent 工作区使用的轻量缩略图。优先读取缩略图缓存，避免为对话预览解码完整输出图。
 */
export default function AgentImagePreview({
  imageId,
  imageIds = [],
  fallbackSrc = '',
  alt,
  className = '',
  interactive = true,
  previewState,
  onOpen,
}: AgentImagePreviewProps) {
  const [src, setSrc] = useState(fallbackSrc)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSrc(fallbackSrc)
    setLoadFailed(false)
    if (!imageId) return

    const applyThumbnail = (thumbnail: { dataUrl: string }) => {
      if (!cancelled) setSrc(thumbnail.dataUrl)
    }
    const unsubscribe = subscribeImageThumbnail(imageId, applyThumbnail)

    void ensureImageThumbnailCached(imageId)
      .then((thumbnail) => {
        if (thumbnail) applyThumbnail(thumbnail)
      })
      .catch(() => {
        if (!cancelled && !fallbackSrc) setLoadFailed(true)
      })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [fallbackSrc, imageId])

  const lightboxImageIds = imageId && imageIds.includes(imageId)
    ? [...imageIds]
    : imageId
      ? [imageId, ...imageIds]
      : [...imageIds]
  const canOpen = Boolean(interactive && imageId && onOpen)
  const resolvedState = previewState ?? (loadFailed ? 'error' : src ? 'ready' : 'loading')
  const preview = src && resolvedState === 'ready' ? (
    <img
      src={src}
      alt={alt}
      data-image-id={imageId || undefined}
      className="saveable-image h-full w-full object-contain"
      onError={() => setLoadFailed(true)}
    />
  ) : (
    <div
      data-preview-state={resolvedState}
      className={`flex h-full w-full items-center justify-center px-4 text-center text-xs ${
        resolvedState === 'error'
          ? 'text-red-500 dark:text-red-400'
          : 'text-gray-400 dark:text-gray-500'
      }`}
    >
      {resolvedState === 'error'
        ? '预览加载失败'
        : imageId
          ? '正在准备预览'
          : '等待图片输出'}
    </div>
  )

  const previewClassName = `relative flex aspect-square w-40 max-h-40 max-w-full shrink-0 items-center justify-center overflow-hidden rounded-xl border border-gray-200 bg-gray-100 dark:border-white/[0.08] dark:bg-black/20 ${className}`

  if (canOpen && imageId && onOpen) {
    return (
      <button
        type="button"
        data-agent-image-preview
        data-image-id={imageId}
        data-lightbox-image-list={lightboxImageIds.join(' ')}
        aria-label={`查看${alt}`}
        className={`${previewClassName} cursor-zoom-in transition hover:border-gray-300 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:hover:border-white/[0.16] dark:hover:bg-white/[0.04]`}
        style={{ width: 'min(100%, 10rem)', maxWidth: '10rem', maxHeight: '10rem' }}
        onClick={() => onOpen(imageId, lightboxImageIds)}
      >
        {preview}
      </button>
    )
  }

  return (
    <div
      data-agent-image-preview
      data-image-id={imageId || undefined}
      data-preview-interactive="false"
      className={previewClassName}
      style={{ width: 'min(100%, 10rem)', maxWidth: '10rem', maxHeight: '10rem' }}
    >
      {preview}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { ensureImageThumbnailCached, subscribeImageThumbnail } from '../store'

interface AgentImagePreviewProps {
  imageId?: string
  fallbackSrc?: string
  alt: string
  className?: string
}

/**
 * Agent 工作区使用的轻量缩略图。优先读取缩略图缓存，避免为对话预览解码完整输出图。
 */
export default function AgentImagePreview({
  imageId,
  fallbackSrc = '',
  alt,
  className = '',
}: AgentImagePreviewProps) {
  const [src, setSrc] = useState(fallbackSrc)

  useEffect(() => {
    let cancelled = false
    setSrc(fallbackSrc)
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
        // 缩略图回填失败时保留占位，不影响任务记录本身。
      })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [fallbackSrc, imageId])

  return (
    <div
      data-agent-image-preview
      className={`relative overflow-hidden rounded-xl border border-gray-200 bg-gray-100 dark:border-white/[0.08] dark:bg-black/20 ${className}`}
    >
      {src ? (
        <img src={src} alt={alt} className="h-full w-full object-contain" />
      ) : (
        <div className="flex h-full min-h-28 items-center justify-center px-4 text-center text-xs text-gray-400 dark:text-gray-500">
          {imageId ? '正在准备预览' : '等待图片输出'}
        </div>
      )}
    </div>
  )
}

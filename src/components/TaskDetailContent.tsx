import { useEffect, useMemo, useState } from 'react'
import type { TaskRecord } from '../types'
import {
  editOutputs,
  ensureImageCached,
  getCachedImage,
  removeTask,
  retryTask,
  reuseConfig,
  updateTaskInStore,
  useStore,
} from '../store'
import { DetailParamValue } from '../lib/paramDisplay'
import { formatImageRatio } from '../lib/size'
import { copyTextToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import { getOpenShopHash } from '../lib/openshopRoute'

interface TaskDetailContentProps {
  task: TaskRecord
  presentation?: 'modal' | 'workspace'
  onRequestClose?: () => void
  onDeleteCommitted?: () => void
  onAdvancedEdit?: (imageId: string, taskId: string) => void
}

export default function TaskDetailContent({
  task,
  presentation = 'workspace',
  onRequestClose,
  onDeleteCommitted,
  onAdvancedEdit,
}: TaskDetailContentProps) {
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const setMaskEditorImageId = useStore((s) => s.setMaskEditorImageId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)
  const [imageIndex, setImageIndex] = useState(0)
  const [outputSrc, setOutputSrc] = useState('')
  const [inputSrcs, setInputSrcs] = useState<Record<string, string>>({})
  const [imageMeta, setImageMeta] = useState<{ ratio: string; size: string } | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    setImageIndex(0)
  }, [task.id])

  useEffect(() => {
    if (task.status !== 'running' && !(task.status === 'error' && (task.falRecoverable || task.customRecoverable))) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    setNow(Date.now())
    return () => window.clearInterval(id)
  }, [task.customRecoverable, task.falRecoverable, task.status])

  const outputImageId = task.outputImages[imageIndex] ?? ''
  const inputImageIds = task.inputImageIds ?? []

  useEffect(() => {
    let cancelled = false
    setOutputSrc('')
    setImageMeta(null)
    if (!outputImageId) return

    const cached = getCachedImage(outputImageId)
    if (cached) {
      setOutputSrc(cached)
      return
    }

    ensureImageCached(outputImageId)
      .then((src) => {
        if (!cancelled && src) setOutputSrc(src)
      })
      .catch(() => {
        if (!cancelled) setOutputSrc('')
      })

    return () => {
      cancelled = true
    }
  }, [outputImageId])

  useEffect(() => {
    let cancelled = false
    const initial: Record<string, string> = {}
    for (const imageId of inputImageIds) {
      const cached = getCachedImage(imageId)
      if (cached) initial[imageId] = cached
    }
    setInputSrcs(initial)

    for (const imageId of inputImageIds) {
      if (initial[imageId]) continue
      ensureImageCached(imageId)
        .then((src) => {
          if (!cancelled && src) setInputSrcs((prev) => ({ ...prev, [imageId]: src }))
        })
        .catch(() => {
          if (!cancelled) setInputSrcs((prev) => ({ ...prev, [imageId]: '' }))
        })
    }

    return () => {
      cancelled = true
    }
  }, [inputImageIds])

  const currentActualParams = outputImageId ? task.actualParamsByImage?.[outputImageId] : undefined
  const currentRevisedPrompt = outputImageId ? task.revisedPromptByImage?.[outputImageId]?.trim() : ''
  const showRevisedPrompt = Boolean(currentRevisedPrompt && currentRevisedPrompt !== task.prompt.trim())
  const isRecovering = task.status === 'error' && (task.falRecoverable || task.customRecoverable)
  const taskProviderName = task.apiProvider === 'fal' ? 'fal.ai' : task.apiProvider ? task.apiProvider : '未知'
  const showSourceInfo = Boolean(task.apiProvider || task.apiProfileName || task.apiModel)
  const duration = useMemo(() => {
    if (task.status === 'running' || isRecovering) {
      const seconds = Math.max(0, Math.floor((now - task.createdAt) / 1000))
      return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    }
    if (task.elapsed == null) return null
    const seconds = Math.floor(task.elapsed / 1000)
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  }, [isRecovering, now, task.createdAt, task.elapsed, task.status])

  const closeIfModal = () => {
    if (presentation === 'modal') onRequestClose?.()
  }

  const focusInputEditor = () => {
    requestAnimationFrame(() => {
      const inputEditor = document.querySelector<HTMLElement>('[data-input-bar] [contenteditable="true"]')
      inputEditor?.focus()
      inputEditor?.scrollIntoView({ block: 'nearest' })
    })
  }

  const handleReuse = () => {
    void reuseConfig(task).then(focusInputEditor)
    closeIfModal()
  }

  const handleEditOutputs = () => {
    void editOutputs(task).then(focusInputEditor)
    closeIfModal()
  }

  const handleMaskEditCurrentOutput = () => {
    if (!outputImageId) return
    setMaskEditorImageId(outputImageId)
    closeIfModal()
  }

  const handleAdvancedEdit = () => {
    if (!outputImageId) return

    if (onAdvancedEdit) {
      onAdvancedEdit(outputImageId, task.id)
    } else {
      window.location.hash = getOpenShopHash(outputImageId, task.id)
    }

    closeIfModal()
  }

  const handleCopyPrompt = async () => {
    if (!task.prompt) return
    try {
      await copyTextToClipboard(task.prompt)
      showToast('提示词已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制提示词失败', err), 'error')
    }
  }

  const handleCopyRawUrls = async () => {
    const rawImageUrls = task.rawImageUrls ?? []
    if (!rawImageUrls.length) return
    try {
      await copyTextToClipboard(rawImageUrls.join('\n'))
      showToast('图片链接已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制链接失败', err), 'error')
    }
  }

  const handleCopyRawResponse = async () => {
    if (!task.rawResponsePayload) return
    try {
      await copyTextToClipboard(task.rawResponsePayload)
      showToast('原始响应已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制原始响应失败', err), 'error')
    }
  }

  const handleDelete = () => {
    closeIfModal()
    setConfirmDialog({
      title: '删除记录',
      message: '确定要删除这条记录吗？关联的图片资源也会被清理（如果没有其他任务引用）。',
      action: () => {
        void removeTask(task).then(onDeleteCommitted)
      },
    })
  }

  return (
    <article className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-white/[0.08] dark:bg-gray-900">
      <div className="min-h-[18rem] flex-1 bg-gray-100 dark:bg-black/20 relative flex items-center justify-center">
        {task.status === 'running' && (
          <div className="flex flex-col items-center gap-3 text-blue-500">
            <svg className="h-10 w-10 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm">生成中</span>
          </div>
        )}
        {task.status === 'error' && (
          <div className="max-w-lg px-6 text-center">
            <p className={`text-sm font-medium ${isRecovering ? 'text-yellow-500' : 'text-red-500'}`}>
              {isRecovering ? '任务恢复中' : (task.error || '生成失败')}
            </p>
          </div>
        )}
        {task.status === 'done' && outputImageId && outputSrc && (
          <img
            src={outputSrc}
            data-image-id={outputImageId}
            className="saveable-image max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)] cursor-pointer object-contain"
            alt=""
            onClick={() => setLightboxImageId(outputImageId, task.outputImages)}
            onLoad={(event) => {
              const image = event.currentTarget
              if (image.naturalWidth && image.naturalHeight) {
                setImageMeta({
                  ratio: formatImageRatio(image.naturalWidth, image.naturalHeight),
                  size: `${image.naturalWidth}×${image.naturalHeight}`,
                })
              }
            }}
          />
        )}
        {duration && (
          <span className="absolute left-4 top-4 rounded bg-black/50 px-2 py-0.5 font-mono text-xs text-white backdrop-blur-sm">
            {duration}
          </span>
        )}
        {imageMeta && (
          <span className="absolute right-4 top-4 rounded bg-black/50 px-2 py-0.5 text-xs text-white backdrop-blur-sm">
            {imageMeta.ratio} · {imageMeta.size}
          </span>
        )}
        {task.outputImages.length > 1 && (
          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/45 px-2 py-1 text-xs text-white">
            <button type="button" className="px-2" onClick={() => setImageIndex((imageIndex - 1 + task.outputImages.length) % task.outputImages.length)}>
              上一张
            </button>
            <span>{imageIndex + 1} / {task.outputImages.length}</span>
            <button type="button" className="px-2" onClick={() => setImageIndex((imageIndex + 1) % task.outputImages.length)}>
              下一张
            </button>
          </div>
        )}
      </div>

      <div className="max-h-[42vh] overflow-y-auto p-5">
        <div className="mb-4">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500">输入内容</h3>
            {task.prompt && (
              <button
                type="button"
                className="rounded px-2 py-1 text-xs text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
                onClick={handleCopyPrompt}
                title="复制提示词"
              >
                复制
              </button>
            )}
          </div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700 dark:text-gray-300">{task.prompt || '(无提示词)'}</p>
          {showRevisedPrompt && (
            <p className="mt-3 whitespace-pre-wrap rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-yellow-500/10 dark:text-yellow-300">
              {currentRevisedPrompt}
            </p>
          )}
        </div>

        {inputImageIds.length > 0 && (
          <div className="mb-4">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500">参考图</h3>
            <div className="flex flex-wrap gap-2">
              {inputImageIds.map((imageId) => {
                const isMaskTarget = imageId === task.maskTargetImageId || (!task.maskTargetImageId && Boolean(task.maskImageId) && imageId === inputImageIds[0])
                const src = inputSrcs[imageId] ?? ''
                return (
                  <button
                    key={imageId}
                    type="button"
                    className={`relative h-16 w-16 overflow-hidden rounded-lg border bg-gray-100 transition hover:opacity-85 dark:bg-black/20 ${
                      isMaskTarget ? 'border-2 border-blue-500' : 'border-gray-200 dark:border-white/[0.08]'
                    }`}
                    onClick={() => setLightboxImageId(imageId, inputImageIds)}
                    title="查看参考图"
                  >
                    {src ? <img src={src} data-image-id={imageId} className="h-full w-full object-cover" alt="" /> : null}
                    {isMaskTarget && (
                      <span className="absolute left-1 top-1 rounded bg-blue-500/90 px-1.5 py-0.5 text-[8px] font-bold leading-none text-white">
                        MASK
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="mb-4">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500">参数配置</h3>
          {showSourceInfo && (
            <div className="mb-2 rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-white/[0.03]">
              <span className="text-gray-400 dark:text-gray-500">来源</span>
              <br />
              <span className="font-medium text-gray-700 dark:text-gray-200">{taskProviderName}</span>
              <span className="text-gray-400 dark:text-gray-500"> · {task.apiProfileName || '未知配置'} · {task.apiModel || '未知模型'}</span>
              {task.sourceTaskId && (
                <>
                  <br />
                  <span className="text-gray-400 dark:text-gray-500">溯源任务</span>
                  <span className="ml-1 font-mono text-gray-600 dark:text-gray-300">{task.sourceTaskId}</span>
                </>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 text-xs">
            {(['size', 'quality', 'output_format', 'moderation', 'n'] as const).map((paramKey) => (
              <div key={paramKey} className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-white/[0.03]">
                <span className="text-gray-400 dark:text-gray-500">{paramKey}</span>
                <br />
                <DetailParamValue task={task} paramKey={paramKey} className="font-medium" actualParams={currentActualParams} />
              </div>
            ))}
          </div>
        </div>

        {(task.rawImageUrls?.length || task.rawResponsePayload) && (
          <div className="mb-4">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500">原始响应</h3>
            {task.rawImageUrls?.length ? (
              <div className="mb-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:bg-white/[0.03] dark:text-gray-300">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-gray-400 dark:text-gray-500">图片链接</span>
                  <button type="button" className="rounded px-2 py-1 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200" onClick={handleCopyRawUrls}>
                    全部复制
                  </button>
                </div>
                <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all">{task.rawImageUrls.join('\n')}</pre>
              </div>
            ) : null}
            {task.rawResponsePayload ? (
              <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:bg-white/[0.03] dark:text-gray-300">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-gray-400 dark:text-gray-500">原始响应数据</span>
                  <button type="button" className="rounded px-2 py-1 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200" onClick={handleCopyRawResponse}>
                    全部复制
                  </button>
                </div>
                <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all">
                  {task.rawResponsePayload.replace(/"(b64_json|base64|data)":\s*"[^"]+"/g, '"$1": "<base64_data>"')}
                </pre>
              </div>
            ) : null}
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-t border-gray-100 pt-4 dark:border-white/[0.08]">
          <button type="button" className="rounded-xl bg-blue-50 px-3 py-2 text-sm font-medium text-blue-600 hover:bg-blue-100 dark:bg-blue-500/10 dark:text-blue-400" onClick={handleReuse}>
            复用配置
          </button>
          <button type="button" disabled={!task.outputImages.length} className="rounded-xl bg-green-50 px-3 py-2 text-sm font-medium text-green-600 hover:bg-green-100 disabled:opacity-40 dark:bg-green-500/10 dark:text-green-400" onClick={handleEditOutputs}>
            编辑输出
          </button>
          <button type="button" disabled={!outputImageId} className="inline-flex items-center gap-1 rounded-xl bg-violet-50 px-3 py-2 text-sm font-medium text-violet-600 hover:bg-violet-100 disabled:opacity-40 dark:bg-violet-500/10 dark:text-violet-300" onClick={handleAdvancedEdit}>
            高级编辑
          </button>
          <button type="button" disabled={!outputImageId} className="rounded-xl bg-purple-50 px-3 py-2 text-sm font-medium text-purple-600 hover:bg-purple-100 disabled:opacity-40 dark:bg-purple-500/10 dark:text-purple-400" onClick={handleMaskEditCurrentOutput}>
            遮罩编辑
          </button>
          <button type="button" className="rounded-xl bg-gray-50 px-3 py-2 text-sm font-medium text-gray-500 hover:bg-yellow-50 hover:text-yellow-500 dark:bg-white/[0.04]" onClick={() => updateTaskInStore(task.id, { isFavorite: !task.isFavorite })}>
            {task.isFavorite ? '取消收藏' : '收藏'}
          </button>
          {task.origin !== 'restricted-agent' && task.origin !== 'openshop' && (
            <button type="button" className="rounded-xl bg-blue-50 px-3 py-2 text-sm font-medium text-blue-600 hover:bg-blue-100 dark:bg-blue-500/10 dark:text-blue-400" onClick={() => { retryTask(task); closeIfModal() }}>
              重试
            </button>
          )}
          <button type="button" className="rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-100 dark:bg-red-500/10 dark:text-red-400" onClick={handleDelete}>
            删除记录
          </button>
        </div>
      </div>
    </article>
  )
}

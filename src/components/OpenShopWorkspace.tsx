import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  dataUrlToOpenShopDocument,
  getOpenShopTargetOrigin,
  isOpenShopMessageFromFrame,
  postOpenShopMessage,
} from '../lib/openshopBridge'

export interface OpenShopWorkspaceProps {
  imageId: string
  taskId: string | null
  sourceDataUrl?: string
  sourceError?: string
  onClose: () => void
  onSave?: (blob: Blob, filename: string) => Promise<void> | void
  editor?: ReactNode
}

export interface OpenShopConfigurationGate {
  hasFrameWindow: boolean
  hasSourceDataUrl: boolean
  hasTargetOrigin: boolean
  editorReady: boolean
  isConfigured: boolean
  isConfiguring: boolean
}

export function shouldSendOpenShopConfiguration({
  hasFrameWindow,
  hasSourceDataUrl,
  hasTargetOrigin,
  editorReady,
  isConfigured,
  isConfiguring,
}: OpenShopConfigurationGate): boolean {
  return hasFrameWindow
    && hasSourceDataUrl
    && hasTargetOrigin
    && editorReady
    && !isConfigured
    && !isConfiguring
}

/**
 * OpenShop 的宿主界面。
 *
 * 图片读取、postMessage 协议以及编辑结果入库由外层 bridge 负责；该组件仅提供
 * 一致的页面骨架和可替换的编辑器挂载点，避免与应用 store 耦合。
 */
export default function OpenShopWorkspace({
  imageId,
  taskId,
  sourceDataUrl,
  sourceError,
  onClose,
  onSave,
  editor,
}: OpenShopWorkspaceProps) {
  const workspaceRef = useRef<HTMLElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const editorReadyRef = useRef(false)
  const configurationInFlightRef = useRef(false)
  const configuredRef = useRef(false)
  const helloSentRef = useRef(false)
  const saveRequestIdRef = useRef<string | null>(null)
  const [isConfigured, setIsConfigured] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [fullscreenNotice, setFullscreenNotice] = useState<string | null>(null)
  const [status, setStatus] = useState(sourceDataUrl ? '正在加载 OpenShop…' : '正在读取原图…')
  const [error, setError] = useState<string | null>(null)
  const frameSrc = `${import.meta.env.BASE_URL}openshop/`
  const targetOrigin = useMemo(() => {
    if (typeof window === 'undefined') return ''
    return getOpenShopTargetOrigin(new URL(frameSrc, window.location.href).toString())
  }, [frameSrc])

  const sendHello = useCallback((retry = false) => {
    const frameWindow = frameRef.current?.contentWindow
    if (!frameWindow || !targetOrigin || (helloSentRef.current && !retry)) return
    helloSentRef.current = true
    postOpenShopMessage(frameWindow, targetOrigin, { type: 'openshop:hello', id: 'hello' })
  }, [targetOrigin])

  const sendConfiguration = useCallback(async () => {
    const frameWindow = frameRef.current?.contentWindow
    if (!frameWindow || !sourceDataUrl || !targetOrigin) return
    if (!shouldSendOpenShopConfiguration({
      hasFrameWindow: true,
      hasSourceDataUrl: true,
      hasTargetOrigin: true,
      editorReady: editorReadyRef.current,
      isConfigured: configuredRef.current,
      isConfiguring: configurationInFlightRef.current,
    })) return

    configurationInFlightRef.current = true
    setStatus('正在导入原图…')
    try {
      const document = await dataUrlToOpenShopDocument(sourceDataUrl, `source-${imageId.slice(0, 12)}.png`)
      if (frameRef.current?.contentWindow !== frameWindow || !editorReadyRef.current) {
        configurationInFlightRef.current = false
        return
      }
      postOpenShopMessage(frameWindow, targetOrigin, {
        type: 'openshop:configure',
        id: 'configure',
        document,
        overrides: { open: false, save: false },
      })
    } catch (cause) {
      configurationInFlightRef.current = false
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [imageId, sourceDataUrl, targetOrigin])

  useEffect(() => {
    if (!targetOrigin) return

    const onMessage = (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow ?? null
      if (!isOpenShopMessageFromFrame(event, frameWindow, targetOrigin)) return

      const message = event.data
      if (message.type === 'openshop:ready') {
        if (message.id === 'hello') {
          editorReadyRef.current = true
          void sendConfiguration()
          return
        }
        sendHello()
        return
      }

      if (message.type === 'openshop:configured') {
        configurationInFlightRef.current = false
        configuredRef.current = true
        setIsConfigured(true)
        setStatus('编辑器已就绪')
        return
      }

      if (message.type === 'openshop:exported' && message.id === saveRequestIdRef.current) {
        const blob = message.blob
        const filename = message.filename
        saveRequestIdRef.current = null
        if (!(blob instanceof Blob) || typeof filename !== 'string' || !blob.type.startsWith('image/')) {
          setIsSaving(false)
          setError('OpenShop 未返回可保存的图片文件')
          return
        }
        void Promise.resolve(onSave?.(blob, filename))
          .then(() => {
            setStatus('已保存为新的编辑历史记录')
          })
          .catch((cause) => {
            setError(cause instanceof Error ? cause.message : String(cause))
          })
          .finally(() => setIsSaving(false))
        return
      }

      if (message.type === 'openshop:error') {
        if (message.id === 'configure') {
          configurationInFlightRef.current = false
          configuredRef.current = false
        }
        if (message.id === saveRequestIdRef.current) {
          saveRequestIdRef.current = null
          setIsSaving(false)
        }
        setError(typeof message.message === 'string' ? message.message : 'OpenShop 拒绝了请求')
      }
    }

    window.addEventListener('message', onMessage)
    // iframe 可能在 React effect 注册前已完成加载。重发同一握手是幂等的，
    // 可以避免第一次 ready 回复落在监听器建立之前而无法继续配置。
    sendHello(true)
    return () => window.removeEventListener('message', onMessage)
  }, [onSave, sendConfiguration, sendHello, targetOrigin])

  useEffect(() => {
    if (!sourceDataUrl || !editorReadyRef.current) return
    void sendConfiguration()
  }, [sendConfiguration, sourceDataUrl])

  useEffect(() => {
    if (sourceError) setError(sourceError)
  }, [sourceError])

  useEffect(() => {
    if (typeof document === 'undefined') return

    const syncFullscreenState = () => {
      const workspaceIsFullscreen = document.fullscreenElement === workspaceRef.current
      setIsFullscreen(workspaceIsFullscreen)
      setFullscreenNotice(workspaceIsFullscreen ? '已进入全屏模式，按 Esc 可退出。' : null)
    }

    const handleFullscreenError = () => {
      const workspaceIsFullscreen = document.fullscreenElement === workspaceRef.current
      setIsFullscreen(workspaceIsFullscreen)
      setFullscreenNotice(workspaceIsFullscreen
        ? '无法退出全屏模式，请按 Esc 重试。'
        : '无法进入全屏模式，请检查浏览器权限后重试。')
    }

    document.addEventListener('fullscreenchange', syncFullscreenState)
    document.addEventListener('fullscreenerror', handleFullscreenError)
    syncFullscreenState()
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState)
      document.removeEventListener('fullscreenerror', handleFullscreenError)
    }
  }, [])

  const handleFullscreenToggle = useCallback(async () => {
    const workspace = workspaceRef.current
    if (typeof document === 'undefined' || !workspace) {
      setFullscreenNotice('全屏区域尚未准备好，请稍后重试。')
      return
    }

    if (document.fullscreenElement === workspace) {
      if (typeof document.exitFullscreen !== 'function') {
        setFullscreenNotice('当前浏览器不支持退出全屏模式，请按 Esc 重试。')
        return
      }

      setFullscreenNotice(null)
      try {
        await document.exitFullscreen()
      } catch {
        setFullscreenNotice('无法退出全屏模式，请按 Esc 重试。')
      }
      return
    }

    if (document.fullscreenEnabled === false || typeof workspace.requestFullscreen !== 'function') {
      setFullscreenNotice('当前浏览器不支持全屏模式。')
      return
    }

    setFullscreenNotice(null)
    try {
      await workspace.requestFullscreen()
    } catch {
      setIsFullscreen(document.fullscreenElement === workspace)
      setFullscreenNotice('无法进入全屏模式，请检查浏览器权限后重试。')
    }
  }, [])

  const handleSave = () => {
    const frameWindow = frameRef.current?.contentWindow
    if (!frameWindow || !targetOrigin || !isConfigured || isSaving) return

    const requestId = `save-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    saveRequestIdRef.current = requestId
    setError(null)
    setIsSaving(true)
    setStatus('正在导出 PNG…')
    postOpenShopMessage(frameWindow, targetOrigin, {
      type: 'openshop:export',
      id: requestId,
      format: 'png',
    })
  }

  return (
    <main className="safe-area-x mx-auto flex min-h-screen max-w-[96rem] flex-col py-4 sm:py-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm dark:border-white/[0.08] dark:bg-gray-900 sm:px-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold text-gray-900 dark:text-white">高级编辑</h1>
            <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-600 dark:bg-violet-500/10 dark:text-violet-300">OpenShop</span>
          </div>
          <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400" title={imageId}>
            编辑完成后会作为一条新的历史记录保存，原图不会被覆盖。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleFullscreenToggle()}
            aria-pressed={isFullscreen}
            aria-label={isFullscreen ? '退出 OpenShop 全屏显示' : '全屏显示 OpenShop'}
            data-openshop-fullscreen-toggle
            className="inline-flex min-h-10 items-center rounded-xl px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]"
          >
            {isFullscreen ? '退出全屏' : '全屏显示'}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!isConfigured || isSaving}
            className="min-h-10 rounded-xl bg-violet-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isSaving ? '保存中…' : '保存到历史'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-10 items-center rounded-xl px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]"
          >
            返回画廊
          </button>
        </div>
      </header>

      <div className="mb-3 flex min-h-5 items-center justify-between gap-3 px-1 text-xs" aria-live="polite">
        <span className="text-gray-500 dark:text-gray-400">{status}</span>
        <div className="flex items-center gap-3 text-right">
          {fullscreenNotice && (
            <span className={isFullscreen ? 'text-gray-500 dark:text-gray-400' : 'text-red-600 dark:text-red-400'}>
              {fullscreenNotice}
            </span>
          )}
          {error && <span className="text-red-600 dark:text-red-400">{error}</span>}
        </div>
      </div>

      <section
        ref={workspaceRef}
        className="relative min-h-[calc(100vh-9.5rem)] flex-1 overflow-hidden rounded-2xl border border-gray-200 bg-gray-100 shadow-sm dark:border-white/[0.08] dark:bg-black/20"
        data-openshop-workspace
        data-image-id={imageId}
        data-task-id={taskId ?? undefined}
        data-source-ready={sourceDataUrl ? 'true' : 'false'}
      >
        {editor ?? (
          <iframe
            title="OpenShop 高级编辑器"
            src={`${import.meta.env.BASE_URL}openshop/`}
            ref={frameRef}
            className="absolute inset-0 h-full w-full border-0 bg-white"
            data-openshop-frame
            allow="clipboard-read; clipboard-write; fullscreen"
            allowFullScreen
            onLoad={() => {
              editorReadyRef.current = false
              configurationInFlightRef.current = false
              configuredRef.current = false
              saveRequestIdRef.current = null
              setIsConfigured(false)
              if (sourceDataUrl) setStatus('正在连接编辑器…')
              sendHello(true)
            }}
          />
        )}
      </section>
    </main>
  )
}

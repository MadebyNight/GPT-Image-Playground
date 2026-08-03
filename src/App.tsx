import { useCallback, useEffect, useState } from 'react'
import { ensureImageCached, initStore, saveOpenShopEdit, useStore } from './store'
import { buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import { getOpenShopRoute, type OpenShopRoute } from './lib/openshopRoute'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import { useRestrictedAgentStore } from './restrictedAgentStore'
import { isRestrictedAgentEnabled, isRestrictedAgentOnly } from './lib/serverApiConfig'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import AgentWorkspace from './components/AgentWorkspace'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import OpenShopWorkspace from './components/OpenShopWorkspace'

function getCurrentOpenShopRoute(): OpenShopRoute | null {
  if (typeof window === 'undefined') return null
  return getOpenShopRoute(window.location.hash)
}

export default function App() {
  const setSettings = useStore((s) => s.setSettings)
  const recoverRestrictedAgent = useRestrictedAgentStore((s) => s.recover)
  const restrictedAgentEnabled = isRestrictedAgentEnabled()
  const restrictedAgentOnly = restrictedAgentEnabled && isRestrictedAgentOnly()
  const [workspaceMode, setWorkspaceMode] = useState<'gallery' | 'agent'>(() => restrictedAgentOnly ? 'agent' : 'gallery')
  const [activeAgentTaskId, setActiveAgentTaskId] = useState<string | null>(null)
  const [openShopRoute, setOpenShopRoute] = useState<OpenShopRoute | null>(getCurrentOpenShopRoute)
  const [openShopSource, setOpenShopSource] = useState<string | undefined>()
  const [openShopSourceError, setOpenShopSourceError] = useState<string | undefined>()
  useDockerApiUrlMigrationNotice()

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const nextSettings = buildSettingsFromUrlParams(useStore.getState().settings, searchParams)

    setSettings(nextSettings)

    if (hasUrlSettingParams(searchParams)) {
      clearUrlSettingParams(searchParams)

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    void (async () => {
      await initStore()
      if (restrictedAgentEnabled) {
        await recoverRestrictedAgent(useStore.getState().tasks)
      }
    })()
  }, [recoverRestrictedAgent, restrictedAgentEnabled, setSettings])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  useEffect(() => {
    const syncOpenShopRoute = () => setOpenShopRoute(getCurrentOpenShopRoute())
    window.addEventListener('hashchange', syncOpenShopRoute)
    return () => window.removeEventListener('hashchange', syncOpenShopRoute)
  }, [])

  useEffect(() => {
    let cancelled = false
    setOpenShopSource(undefined)
    setOpenShopSourceError(undefined)
    if (!openShopRoute) return

    void ensureImageCached(openShopRoute.imageId)
      .then((source) => {
        if (cancelled) return
        if (!source) {
          setOpenShopSourceError('未找到原图，它可能已被清理或不在当前浏览器中。')
          return
        }
        setOpenShopSource(source)
      })
      .catch((cause) => {
        if (!cancelled) setOpenShopSourceError(cause instanceof Error ? cause.message : String(cause))
      })

    return () => {
      cancelled = true
    }
  }, [openShopRoute])

  const closeOpenShop = useCallback(() => {
    const nextUrl = `${window.location.pathname}${window.location.search}`
    window.history.replaceState(null, '', nextUrl)
    setOpenShopRoute(null)
  }, [])

  const saveOpenShopHistory = useCallback(async (blob: Blob) => {
    if (!openShopRoute?.taskId) throw new Error('缺少原始任务，无法建立编辑溯源记录')
    await saveOpenShopEdit({
      sourceTaskId: openShopRoute.taskId,
      inputImageIds: [openShopRoute.imageId],
      outputImage: blob,
    })
    useStore.getState().showToast('已保存 OpenShop 编辑历史', 'success')
  }, [openShopRoute])

  if (openShopRoute) {
    return (
      <>
        <OpenShopWorkspace
          key={`${openShopRoute.taskId ?? 'unknown'}:${openShopRoute.imageId}`}
          imageId={openShopRoute.imageId}
          taskId={openShopRoute.taskId}
          sourceDataUrl={openShopSource}
          sourceError={openShopSourceError}
          onClose={closeOpenShop}
          onSave={saveOpenShopHistory}
        />
        <Toast />
      </>
    )
  }

  return (
    <>
      <Header />
      <main data-home-main data-drag-select-surface className={workspaceMode === 'agent' ? 'pb-8' : 'pb-48'}>
        <div className={`safe-area-x mx-auto ${
          workspaceMode === 'agent'
            ? 'w-full max-w-[96rem] 2xl:max-w-[108rem]'
            : 'max-w-7xl'
        }`}>
          {!restrictedAgentOnly && <div data-no-drag-select className="mt-6 flex justify-center">
            <div className="inline-flex rounded-2xl border border-gray-200 bg-white p-1 shadow-sm dark:border-white/[0.08] dark:bg-gray-900" role="tablist" aria-label="工作区模式">
              <button
                type="button"
                role="tab"
                aria-selected={workspaceMode === 'gallery'}
                className={`rounded-xl px-4 py-2 text-sm transition ${
                  workspaceMode === 'gallery'
                    ? 'bg-blue-500 text-white shadow-sm'
                    : 'text-gray-500 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'
                }`}
                onClick={() => setWorkspaceMode('gallery')}
              >
                画廊
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={workspaceMode === 'agent'}
                className={`rounded-xl px-4 py-2 text-sm transition ${
                  workspaceMode === 'agent'
                    ? 'bg-blue-500 text-white shadow-sm'
                    : 'text-gray-500 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'
                }`}
                onClick={() => setWorkspaceMode('agent')}
              >
                Agent
              </button>
            </div>
          </div>}
          {workspaceMode === 'gallery' ? (
            <>
              <SearchBar />
              <TaskGrid />
            </>
          ) : (
            <div className="mt-4">
              <AgentWorkspace
                activeTaskId={activeAgentTaskId}
                onActiveTaskChange={setActiveAgentTaskId}
              />
            </div>
          )}
        </div>
      </main>
      <InputBar
        layout={workspaceMode === 'agent' ? 'agent' : 'default'}
        onTaskSubmitted={workspaceMode === 'agent' ? setActiveAgentTaskId : undefined}
      />
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <ConfirmDialog />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
    </>
  )
}

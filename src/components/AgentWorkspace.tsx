import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useStore } from '../store'
import { filterAgentTasksByMode, getConversationTasks } from '../lib/agentConversation'
import { getAgentLayoutPreferences, setAgentLayoutPreferences } from '../lib/agentLayoutPreferences'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import type { AgentCapabilities, AgentMode, TaskRecord } from '../types'
import AgentHistoryPanel from './AgentHistoryPanel'
import AgentMainWorkspace from './AgentMainWorkspace'
import AgentTemplateRail from './AgentTemplateRail'
import {
  CloseIcon,
  HistoryIcon,
  LayoutTemplateIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
} from './icons'

type AgentMobileDrawer = 'history' | 'templates' | null

export function getNextAgentTaskIdAfterRemoval(previousTaskIds: string[], currentTaskIds: string[], removedTaskId: string): string | null {
  const previousIndex = previousTaskIds.indexOf(removedTaskId)
  if (previousIndex < 0) return currentTaskIds[0] ?? null
  return currentTaskIds[previousIndex] ?? currentTaskIds[previousIndex - 1] ?? null
}

interface AgentWorkspaceProps {
  mode: AgentMode
  capabilities: AgentCapabilities
  activeTaskByMode: Record<AgentMode, string | null>
  onActiveTaskChange: (mode: AgentMode, taskId: string | null) => void
  onModeChange: (mode: AgentMode) => void
  composer?: ReactNode
  /** 隐藏时仍保持两个 Main Workspace 挂载，但不自动改写选中项。 */
  active?: boolean
}

function sortTasks(tasks: TaskRecord[]) {
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
}

export default function AgentWorkspace({
  mode,
  capabilities,
  activeTaskByMode,
  onActiveTaskChange,
  onModeChange,
  composer,
  active = true,
}: AgentWorkspaceProps) {
  const tasks = useStore((state) => state.tasks)
  const [layoutPreferences, setLayoutPreferences] = useState(getAgentLayoutPreferences)
  const [mobileDrawer, setMobileDrawer] = useState<AgentMobileDrawer>(null)
  const [isStartingNewConversation, setIsStartingNewConversation] = useState(false)
  const previousTaskIdsRef = useRef<Partial<Record<AgentMode, string[]>>>({})
  const drawerRef = useRef<HTMLDivElement>(null)
  const historyTriggerRef = useRef<HTMLButtonElement>(null)
  const templateTriggerRef = useRef<HTMLButtonElement>(null)

  const tasksByMode = useMemo<Record<AgentMode, TaskRecord[]>>(() => ({
    chat: sortTasks(filterAgentTasksByMode(tasks, 'chat')),
    tool: sortTasks(filterAgentTasksByMode(tasks, 'tool')),
  }), [tasks])
  const selectedTaskByMode = useMemo<Record<AgentMode, TaskRecord | null>>(() => ({
    chat: tasksByMode.chat.find((task) => task.id === activeTaskByMode.chat) ?? null,
    tool: tasksByMode.tool.find((task) => task.id === activeTaskByMode.tool) ?? null,
  }), [activeTaskByMode, tasksByMode])
  const chatConversationTasks = useMemo(
    () => selectedTaskByMode.chat ? getConversationTasks(tasksByMode.chat, selectedTaskByMode.chat) : [],
    [selectedTaskByMode.chat, tasksByMode.chat],
  )
  const chatTask = chatConversationTasks[chatConversationTasks.length - 1] ?? selectedTaskByMode.chat

  useEffect(() => {
    for (const candidateMode of ['chat', 'tool'] as const) {
      const currentTaskIds = tasksByMode[candidateMode].map((task) => task.id)
      const previousTaskIds = previousTaskIdsRef.current[candidateMode]
      previousTaskIdsRef.current[candidateMode] = currentTaskIds
      if (!active) continue

      const activeTaskId = activeTaskByMode[candidateMode]
      const startingNewChat = candidateMode === 'chat' && isStartingNewConversation
      if (!previousTaskIds) {
        if (!activeTaskId && currentTaskIds[0] && !startingNewChat) {
          onActiveTaskChange(candidateMode, currentTaskIds[0])
        }
        continue
      }

      const latestTaskId = currentTaskIds[0] ?? null
      const hasNewLatestTask = Boolean(latestTaskId && !previousTaskIds.includes(latestTaskId))
      if (hasNewLatestTask && latestTaskId) {
        onActiveTaskChange(candidateMode, latestTaskId)
        if (candidateMode === 'chat') setIsStartingNewConversation(false)
        if (candidateMode === mode) setMobileDrawer(null)
        continue
      }

      if (activeTaskId && !currentTaskIds.includes(activeTaskId)) {
        onActiveTaskChange(
          candidateMode,
          getNextAgentTaskIdAfterRemoval(previousTaskIds, currentTaskIds, activeTaskId),
        )
        continue
      }

      if (!activeTaskId && latestTaskId && !startingNewChat) onActiveTaskChange(candidateMode, latestTaskId)
    }
  }, [active, activeTaskByMode, isStartingNewConversation, mode, onActiveTaskChange, tasksByMode])

  const updateDesktopPreferences = (patch: Partial<typeof layoutPreferences>) => {
    setLayoutPreferences((current) => {
      const next = { ...current, ...patch }
      setAgentLayoutPreferences(next)
      return next
    })
  }

  const closeMobileDrawer = useCallback(() => {
    setMobileDrawer((current) => {
      if (current === 'history') requestAnimationFrame(() => historyTriggerRef.current?.focus())
      if (current === 'templates') requestAnimationFrame(() => templateTriggerRef.current?.focus())
      return null
    })
  }, [])

  const handleSelectTask = (taskId: string) => {
    if (mode === 'chat') setIsStartingNewConversation(false)
    onActiveTaskChange(mode, taskId)
    closeMobileDrawer()
  }

  const handleNewConversation = () => {
    setIsStartingNewConversation(true)
    onActiveTaskChange('chat', null)
    closeMobileDrawer()
  }

  useCloseOnEscape(Boolean(mobileDrawer), closeMobileDrawer)
  usePreventBackgroundScroll(Boolean(mobileDrawer), drawerRef)

  useEffect(() => {
    setMobileDrawer(null)
  }, [mode])

  useEffect(() => {
    const drawer = drawerRef.current
    if (!mobileDrawer || !drawer) return

    const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(focusableSelector))
    requestAnimationFrame(() => focusable[0]?.focus())

    const keepFocusInside = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = Array.from(drawer.querySelectorAll<HTMLElement>(focusableSelector))
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    drawer.addEventListener('keydown', keepFocusInside)
    return () => drawer.removeEventListener('keydown', keepFocusInside)
  }, [mobileDrawer])

  const focusComposer = () => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-input-bar-presentation="embedded"] [contenteditable="true"]')?.focus()
    })
  }

  const handleModeKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const nextMode: AgentMode = event.key === 'ArrowLeft' || event.key === 'Home' ? 'chat' : 'tool'
    const tabList = event.currentTarget.closest('[role="tablist"]')
    setMobileDrawer(null)
    onModeChange(nextMode)
    requestAnimationFrame(() => {
      tabList?.querySelector<HTMLButtonElement>(`[data-agent-mode-tab="${nextMode}"]`)?.focus()
    })
  }

  if (!capabilities.defaultMode) {
    return (
      <section className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-6 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
        <h2 className="font-semibold">Agent 尚不可用</h2>
        <p className="mt-2 leading-6">请配置 OpenAI-compatible Responses API，或由部署管理员启用 Tool Agent Gateway。</p>
      </section>
    )
  }

  return (
    <div className="relative flex h-[calc(100dvh-6.5rem)] min-h-[32rem] flex-col overflow-hidden rounded-3xl border border-gray-200/80 bg-white/80 shadow-[0_20px_70px_rgba(15,23,42,0.08)] backdrop-blur-xl dark:border-white/[0.08] dark:bg-gray-950/80 dark:shadow-[0_20px_70px_rgba(0,0,0,0.28)]">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-gray-200/80 px-2 xl:hidden dark:border-white/[0.08]">
        <button
          ref={historyTriggerRef}
          type="button"
          data-agent-mobile-drawer-trigger="history"
          aria-expanded={mobileDrawer === 'history'}
          aria-controls="agent-mobile-history-drawer"
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-gray-500 transition hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:bg-white/[0.06]"
          onClick={() => setMobileDrawer('history')}
          title="打开历史记录"
        >
          <HistoryIcon className="h-5 w-5" aria-hidden="true" />
          <span className="sr-only">打开历史记录</span>
        </button>
        {capabilities.modeSwitching ? (
          <div className="inline-flex rounded-xl bg-gray-100 p-1 dark:bg-white/[0.05]" role="tablist" aria-label="Agent 模式">
            {(['chat', 'tool'] as const).map((candidateMode) => (
              <button
                key={candidateMode}
                type="button"
                role="tab"
                data-agent-mode-tab={candidateMode}
                aria-selected={mode === candidateMode}
                aria-controls={`agent-${candidateMode}-panel`}
                tabIndex={mode === candidateMode ? 0 : -1}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${mode === candidateMode ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}
                onClick={() => onModeChange(candidateMode)}
                onKeyDown={handleModeKeyDown}
              >
                {candidateMode === 'chat' ? 'Chat' : 'Tool'}
              </button>
            ))}
          </div>
        ) : <span className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-400">{mode} agent</span>}
        <button
          ref={templateTriggerRef}
          type="button"
          data-agent-mobile-drawer-trigger="templates"
          aria-expanded={mobileDrawer === 'templates'}
          aria-controls="agent-mobile-templates-drawer"
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-gray-500 transition hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:bg-white/[0.06]"
          onClick={() => setMobileDrawer('templates')}
          title="打开灵感模板"
        >
          <LayoutTemplateIcon className="h-5 w-5" aria-hidden="true" />
          <span className="sr-only">打开灵感模板</span>
        </button>
      </div>

      <div
        data-agent-desktop-layout
        data-agent-history-expanded={layoutPreferences.historyExpanded}
        data-agent-template-expanded={layoutPreferences.templateExpanded}
        className={`relative hidden min-h-0 flex-1 xl:grid ${layoutPreferences.historyExpanded ? 'grid-cols-[15rem_minmax(0,1fr)_3rem]' : 'grid-cols-[3rem_minmax(0,1fr)_3rem]'}`}
      >
        <div className="min-h-0 overflow-hidden border-r border-gray-200/80 bg-gray-50/80 dark:border-white/[0.08] dark:bg-black/10">
          {layoutPreferences.historyExpanded ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-12 shrink-0 items-center justify-end border-b border-gray-200/80 px-1 dark:border-white/[0.08]">
                <button type="button" aria-expanded="true" aria-controls="agent-desktop-history" className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-white/[0.06] dark:hover:text-gray-200" onClick={() => updateDesktopPreferences({ historyExpanded: false })} title="收起历史记录">
                  <PanelLeftCloseIcon className="h-5 w-5" aria-hidden="true" />
                  <span className="sr-only">收起历史记录</span>
                </button>
              </div>
              <div id="agent-desktop-history" className="min-h-0 flex-1"><AgentHistoryPanel mode={mode} activeTaskId={activeTaskByMode[mode]} onSelectTask={handleSelectTask} onNewConversation={mode === 'chat' ? handleNewConversation : undefined} /></div>
            </div>
          ) : (
            <button type="button" aria-expanded="false" aria-controls="agent-desktop-history" className="flex h-full w-full flex-col items-center gap-3 pt-3 text-gray-400 transition hover:bg-gray-100/80 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:hover:bg-white/[0.04] dark:hover:text-gray-200" onClick={() => updateDesktopPreferences({ historyExpanded: true })} title="展开历史记录">
              <PanelLeftOpenIcon className="h-5 w-5" aria-hidden="true" />
              <span className="sr-only">展开历史记录</span>
              <HistoryIcon className="mt-2 h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="flex min-h-0 min-w-0 flex-col bg-white dark:bg-gray-950">
          <div data-agent-desktop-mode-header className="hidden h-12 shrink-0 items-center justify-center border-b border-gray-200/80 xl:flex dark:border-white/[0.08]">
            {capabilities.modeSwitching ? (
              <div data-agent-mode-switcher className="inline-flex rounded-xl border border-gray-200 bg-white/90 p-1 shadow-sm backdrop-blur dark:border-white/[0.08] dark:bg-gray-900/90" role="tablist" aria-label="Agent 模式">
                {(['chat', 'tool'] as const).map((candidateMode) => (
                  <button
                    key={candidateMode}
                    type="button"
                    role="tab"
                    data-agent-mode-tab={candidateMode}
                    aria-selected={mode === candidateMode}
                    aria-controls={`agent-${candidateMode}-panel`}
                    tabIndex={mode === candidateMode ? 0 : -1}
                    className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                      mode === candidateMode
                        ? 'bg-blue-500 text-white shadow-sm'
                        : 'text-gray-500 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'
                    }`}
                    onClick={() => onModeChange(candidateMode)}
                    onKeyDown={handleModeKeyDown}
                  >
                    {candidateMode === 'chat' ? 'Chat' : 'Tool'}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="min-h-0 flex-1"><AgentMainWorkspace mode={mode} chatTask={chatTask} chatConversationTasks={chatConversationTasks} toolTask={selectedTaskByMode.tool} /></div>
          {active ? composer : null}
        </div>
        <div className="min-h-0 border-l border-gray-200/80 bg-gray-50/80 dark:border-white/[0.08] dark:bg-black/10">
          <button type="button" aria-expanded={layoutPreferences.templateExpanded} aria-controls="agent-desktop-templates" className="flex h-full w-full flex-col items-center gap-3 pt-3 text-gray-400 transition hover:bg-gray-100/80 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:hover:bg-white/[0.04] dark:hover:text-gray-200" onClick={() => updateDesktopPreferences({ templateExpanded: !layoutPreferences.templateExpanded })} title={layoutPreferences.templateExpanded ? '关闭灵感模板' : '打开灵感模板'}>
            {layoutPreferences.templateExpanded ? <PanelRightCloseIcon className="h-5 w-5" aria-hidden="true" /> : <PanelRightOpenIcon className="h-5 w-5" aria-hidden="true" />}
            <LayoutTemplateIcon className="mt-2 h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{layoutPreferences.templateExpanded ? '关闭灵感模板' : '打开灵感模板'}</span>
          </button>
        </div>
        {layoutPreferences.templateExpanded && (
          <div id="agent-desktop-templates" className="absolute inset-y-0 right-12 z-30 w-80 overflow-hidden border-l border-gray-200 bg-gray-50 shadow-[-18px_0_50px_rgba(15,23,42,0.12)] dark:border-white/[0.08] dark:bg-gray-950 dark:shadow-[-18px_0_50px_rgba(0,0,0,0.35)]"><AgentTemplateRail /></div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col xl:hidden">
        <div className="min-h-0 flex-1"><AgentMainWorkspace mode={mode} chatTask={chatTask} chatConversationTasks={chatConversationTasks} toolTask={selectedTaskByMode.tool} /></div>
        {active ? composer : null}
      </div>

      {mobileDrawer && (
        <div className="fixed inset-0 z-[45] xl:hidden" data-agent-mobile-drawer={mobileDrawer}>
          <button type="button" className="absolute inset-0 bg-gray-950/45 backdrop-blur-[2px]" aria-label="关闭侧栏" onClick={closeMobileDrawer} />
          <div ref={drawerRef} id={`agent-mobile-${mobileDrawer}-drawer`} role="dialog" aria-modal="true" aria-labelledby={`agent-mobile-${mobileDrawer}-title`} className={`absolute inset-y-0 flex w-[min(22rem,calc(100vw-3rem))] flex-col overflow-hidden bg-white shadow-2xl dark:bg-gray-950 ${mobileDrawer === 'history' ? 'left-0' : 'right-0'}`}>
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 px-4 dark:border-white/[0.08]">
              <h2 id={`agent-mobile-${mobileDrawer}-title`} className="text-sm font-semibold text-gray-900 dark:text-gray-100">{mobileDrawer === 'history' ? '历史记录' : '灵感模板'}</h2>
              <button type="button" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-gray-400 transition hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-white/[0.06]" onClick={closeMobileDrawer} aria-label="关闭侧栏"><CloseIcon className="h-5 w-5" aria-hidden="true" /></button>
            </div>
            <div className="min-h-0 flex-1">
              {mobileDrawer === 'history' ? <AgentHistoryPanel mode={mode} activeTaskId={activeTaskByMode[mode]} onSelectTask={handleSelectTask} onNewConversation={mode === 'chat' ? handleNewConversation : undefined} /> : <AgentTemplateRail onTemplateApplied={() => { closeMobileDrawer(); focusComposer() }} />}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

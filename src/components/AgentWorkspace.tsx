import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useStore } from '../store'
import { filterAgentTasksByMode, getConversationTasks } from '../lib/agentConversation'
import type { AgentCapabilities, AgentMode, TaskRecord } from '../types'
import AgentHistoryPanel from './AgentHistoryPanel'
import AgentMainWorkspace from './AgentMainWorkspace'
import AgentTemplateRail from './AgentTemplateRail'

type AgentMobilePanel = 'history' | 'workspace' | 'templates'

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
  active = true,
}: AgentWorkspaceProps) {
  const tasks = useStore((state) => state.tasks)
  const [mobilePanel, setMobilePanel] = useState<AgentMobilePanel>('workspace')
  const [isStartingNewConversation, setIsStartingNewConversation] = useState(false)
  const previousTaskIdsRef = useRef<Partial<Record<AgentMode, string[]>>>({})

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
        if (candidateMode === mode) setMobilePanel('workspace')
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

  const handleSelectTask = (taskId: string) => {
    if (mode === 'chat') setIsStartingNewConversation(false)
    onActiveTaskChange(mode, taskId)
    setMobilePanel('workspace')
  }

  const handleNewConversation = () => {
    setIsStartingNewConversation(true)
    onActiveTaskChange('chat', null)
    setMobilePanel('workspace')
  }

  const handleModeKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const nextMode: AgentMode = event.key === 'ArrowLeft' || event.key === 'Home' ? 'chat' : 'tool'
    onModeChange(nextMode)
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-agent-mode-tab="${nextMode}"]`)?.focus()
    })
  }

  const panels = [
    { id: 'history' as const, label: '历史' },
    { id: 'workspace' as const, label: '工作区' },
    { id: 'templates' as const, label: '模板' },
  ]

  if (!capabilities.defaultMode) {
    return (
      <section className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-6 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
        <h2 className="font-semibold">Agent 尚不可用</h2>
        <p className="mt-2 leading-6">请配置 OpenAI-compatible Responses API，或由部署管理员启用 Tool Agent Gateway。</p>
      </section>
    )
  }

  return (
    <div className="min-h-0">
      {capabilities.modeSwitching && (
        <div data-agent-mode-switcher className="mb-4 flex justify-center" role="tablist" aria-label="Agent 模式">
          <div className="inline-flex rounded-xl border border-gray-200 bg-white p-1 shadow-sm dark:border-white/[0.08] dark:bg-gray-900">
            {(['chat', 'tool'] as const).map((candidateMode) => (
              <button
                key={candidateMode}
                type="button"
                role="tab"
                data-agent-mode-tab={candidateMode}
                aria-selected={mode === candidateMode}
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
        </div>
      )}

      <div data-agent-mobile-tabs className="mb-3 flex gap-2 xl:hidden" role="tablist" aria-label="Agent 工作台分段">
        {panels.map((panel) => (
          <button
            key={panel.id}
            type="button"
            role="tab"
            aria-selected={mobilePanel === panel.id}
            className={`flex-1 rounded-xl border px-3 py-2 text-sm transition ${
              mobilePanel === panel.id
                ? 'border-blue-400 bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400'
                : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06]'
            }`}
            onClick={() => setMobilePanel(panel.id)}
          >
            {panel.label}
          </button>
        ))}
      </div>

      <div data-agent-desktop-layout className="hidden h-[calc(100vh-13rem)] min-h-[36rem] grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)_minmax(18rem,22rem)] gap-4 2xl:grid-cols-[minmax(22rem,26rem)_minmax(0,1fr)_minmax(19rem,23rem)] xl:grid">
        <div className="min-h-0 overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 dark:border-white/[0.08] dark:bg-gray-950">
          <AgentHistoryPanel
            mode={mode}
            activeTaskId={activeTaskByMode[mode]}
            onSelectTask={handleSelectTask}
            onNewConversation={mode === 'chat' ? handleNewConversation : undefined}
          />
        </div>
        <div className="min-h-0 overflow-hidden pb-36">
          <AgentMainWorkspace
            mode={mode}
            chatTask={chatTask}
            chatConversationTasks={chatConversationTasks}
            toolTask={selectedTaskByMode.tool}
          />
        </div>
        <div className="min-h-0 overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 dark:border-white/[0.08] dark:bg-gray-950">
          <AgentTemplateRail />
        </div>
      </div>

      <div className="xl:hidden">
        <div data-agent-mobile-panel="history" className={mobilePanel === 'history' ? 'block' : 'hidden'}>
          <div className="h-[calc(100vh-15rem)] overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 dark:border-white/[0.08] dark:bg-gray-950">
            <AgentHistoryPanel
              mode={mode}
              activeTaskId={activeTaskByMode[mode]}
              onSelectTask={handleSelectTask}
              onNewConversation={mode === 'chat' ? handleNewConversation : undefined}
            />
          </div>
        </div>
        <div data-agent-mobile-panel="workspace" className={mobilePanel === 'workspace' ? 'block pb-48' : 'hidden'}>
          <AgentMainWorkspace
            mode={mode}
            chatTask={chatTask}
            chatConversationTasks={chatConversationTasks}
            toolTask={selectedTaskByMode.tool}
          />
        </div>
        <div data-agent-mobile-panel="templates" className={mobilePanel === 'templates' ? 'block' : 'hidden'}>
          <div className="h-[calc(100vh-15rem)] overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 dark:border-white/[0.08] dark:bg-gray-950">
            <AgentTemplateRail onTemplateApplied={() => setMobilePanel('workspace')} />
          </div>
        </div>
      </div>
    </div>
  )
}

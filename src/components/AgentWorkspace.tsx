import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { getConversationTasks } from '../lib/agentConversation'
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
  activeTaskId: string | null
  onActiveTaskChange: (taskId: string | null) => void
  onNewConversation?: () => void
  /** 隐藏时仍保持挂载和流订阅，但不因后台任务列表变化改写当前选中项。 */
  active?: boolean
}

export default function AgentWorkspace({ activeTaskId, onActiveTaskChange, onNewConversation, active = true }: AgentWorkspaceProps) {
  const tasks = useStore((s) => s.tasks)
  const [mobilePanel, setMobilePanel] = useState<AgentMobilePanel>('workspace')
  const [isStartingNewConversation, setIsStartingNewConversation] = useState(false)
  const sortedTasks = useMemo(() => [...tasks].sort((a, b) => b.createdAt - a.createdAt), [tasks])
  const previousTaskIdsRef = useRef<string[] | undefined>(undefined)
  const selectedTask = useMemo(
    () => sortedTasks.find((task) => task.id === activeTaskId) ?? null,
    [activeTaskId, sortedTasks],
  )
  const activeConversationTasks = useMemo(
    () => selectedTask ? getConversationTasks(tasks, selectedTask) : [],
    [selectedTask, tasks],
  )
  const activeTask = useMemo(
    () => activeConversationTasks[activeConversationTasks.length - 1] ?? selectedTask,
    [activeConversationTasks, selectedTask],
  )

  useEffect(() => {
    const currentTaskIds = sortedTasks.map((task) => task.id)
    const previousTaskIds = previousTaskIdsRef.current
    previousTaskIdsRef.current = currentTaskIds

    if (!active) return

    if (!previousTaskIds) {
      if (!activeTaskId && currentTaskIds[0] && !isStartingNewConversation) onActiveTaskChange(currentTaskIds[0])
      return
    }

    const latestTaskId = currentTaskIds[0] ?? null
    const previousLatestTaskId = previousTaskIds[0] ?? null
    const hasNewLatestTask = Boolean(latestTaskId && latestTaskId !== previousLatestTaskId && !previousTaskIds.includes(latestTaskId))

    if (hasNewLatestTask && latestTaskId) {
      onActiveTaskChange(latestTaskId)
      setIsStartingNewConversation(false)
      setMobilePanel('workspace')
      return
    }

    if (activeTaskId && !currentTaskIds.includes(activeTaskId)) {
      onActiveTaskChange(getNextAgentTaskIdAfterRemoval(previousTaskIds, currentTaskIds, activeTaskId))
      return
    }

    if (!activeTaskId && latestTaskId && !isStartingNewConversation) onActiveTaskChange(latestTaskId)
  }, [active, activeTaskId, isStartingNewConversation, onActiveTaskChange, sortedTasks])

  const handleSelectTask = (taskId: string) => {
    setIsStartingNewConversation(false)
    onActiveTaskChange(taskId)
    setMobilePanel('workspace')
  }

  const handleNewConversation = () => {
    setIsStartingNewConversation(true)
    onActiveTaskChange(null)
    onNewConversation?.()
    setMobilePanel('workspace')
  }

  const panels = [
    { id: 'history' as const, label: '历史' },
    { id: 'workspace' as const, label: '工作区' },
    { id: 'templates' as const, label: '模板' },
  ]

  return (
    <div className="min-h-0">
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
          <AgentHistoryPanel activeTaskId={activeTaskId} onSelectTask={handleSelectTask} onNewConversation={onNewConversation ? handleNewConversation : undefined} />
        </div>
        <div className="min-h-0 overflow-hidden pb-36">
          <AgentMainWorkspace task={activeTask} conversationTasks={activeConversationTasks} />
        </div>
        <div className="min-h-0 overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 dark:border-white/[0.08] dark:bg-gray-950">
          <AgentTemplateRail />
        </div>
      </div>

      <div className="xl:hidden">
        <div data-agent-mobile-panel="history" className={mobilePanel === 'history' ? 'block' : 'hidden'}>
          <div className="h-[calc(100vh-15rem)] overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 dark:border-white/[0.08] dark:bg-gray-950">
            <AgentHistoryPanel activeTaskId={activeTaskId} onSelectTask={handleSelectTask} onNewConversation={onNewConversation ? handleNewConversation : undefined} />
          </div>
        </div>
        <div data-agent-mobile-panel="workspace" className={mobilePanel === 'workspace' ? 'block pb-48' : 'hidden'}>
          <AgentMainWorkspace task={activeTask} conversationTasks={activeConversationTasks} />
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

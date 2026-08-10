import { useMemo } from 'react'
import { editOutputs, removeTask, reuseConfig, useStore } from '../store'
import { filterAgentTasksByMode, getAgentConversationId, getConversationTasks } from '../lib/agentConversation'
import { filterAndSortTasks } from '../lib/taskFilters'
import type { AgentMode, TaskRecord } from '../types'
import SearchBar from './SearchBar'
import TaskCard from './TaskCard'
import { PlusIcon } from './icons'

interface AgentHistoryPanelProps {
  mode: AgentMode
  activeTaskId: string | null
  onSelectTask: (taskId: string) => void
  onNewConversation?: () => void
}

interface AgentConversationSummary {
  id: string
  task: TaskRecord
  latestTaskId: string
  turnCount: number
}

export default function AgentHistoryPanel({ mode, activeTaskId, onSelectTask, onNewConversation }: AgentHistoryPanelProps) {
  const tasks = useStore((s) => s.tasks)
  const searchQuery = useStore((s) => s.searchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)

  const filteredTasks = useMemo(
    () => filterAndSortTasks(filterAgentTasksByMode(tasks, mode), { searchQuery, filterStatus, filterFavorite }),
    [filterFavorite, filterStatus, mode, searchQuery, tasks],
  )

  const historyItems = useMemo(() => {
    if (mode === 'tool') {
      return filteredTasks.map((task) => ({
        id: task.id,
        task,
        latestTaskId: task.id,
        turnCount: 1,
      }))
    }
    const seenConversationIds = new Set<string>()

    return filteredTasks.reduce<AgentConversationSummary[]>((items, task) => {
      const conversationId = getAgentConversationId(task)
      if (seenConversationIds.has(conversationId)) return items
      seenConversationIds.add(conversationId)

      const conversationTasks = getConversationTasks(tasks, task)
      const latestTask = conversationTasks[conversationTasks.length - 1] ?? task
      items.push({
        id: conversationId,
        task,
        latestTaskId: latestTask.id,
        turnCount: conversationTasks.length || 1,
      })
      return items
    }, [])
  }, [filteredTasks, mode, tasks])

  const activeConversationId = useMemo(() => {
    if (!activeTaskId) return null
    const activeTask = tasks.find((task) => task.id === activeTaskId)
    if (!activeTask) return null
    return mode === 'chat' ? getAgentConversationId(activeTask) : activeTask.id
  }, [activeTaskId, mode, tasks])

  const handleDelete = (task: TaskRecord) => {
    setConfirmDialog({
      title: '删除记录',
      message: '确定要删除这条记录吗？关联的图片资源也会被清理（如果没有其他任务引用）。',
      action: () => {
        void removeTask(task)
      },
    })
  }

  return (
    <aside className="flex h-full min-h-0 flex-col" aria-labelledby="agent-history-title">
      <div className="sticky top-0 z-10 border-b border-gray-100 bg-gray-50/95 p-4 backdrop-blur dark:border-white/[0.08] dark:bg-gray-950/95">
        <div className="flex items-center justify-between gap-3">
          <h2 id="agent-history-title" className="text-sm font-semibold text-gray-900 dark:text-gray-100">历史记录</h2>
          {mode === 'chat' && onNewConversation && (
            <button
              type="button"
              data-agent-new-conversation
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-gray-200 dark:hover:border-blue-500/30 dark:hover:bg-blue-500/10 dark:hover:text-blue-300"
              onClick={onNewConversation}
              title="开始新的 Agent 对话"
            >
              <PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
              新对话
            </button>
          )}
        </div>
        <SearchBar variant="compact" className="mt-3" />
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {historyItems.length === 0 ? (
          <p className="py-10 text-center text-sm text-gray-400 dark:text-gray-500">没有找到匹配的记录</p>
        ) : (
          historyItems.map((conversation) => (
            <div
              key={conversation.id}
              data-agent-conversation-id={mode === 'chat' ? conversation.id : undefined}
              data-agent-run-id={mode === 'tool' ? conversation.id : undefined}
              className="relative"
            >
              <TaskCard
                task={conversation.task}
                variant="compact"
                selectionEnabled={false}
                isSelected={conversation.id === activeConversationId}
                onClick={() => onSelectTask(conversation.latestTaskId)}
                onReuse={() => void reuseConfig(conversation.task)}
                onEditOutputs={() => void editOutputs(conversation.task)}
                onDelete={() => handleDelete(conversation.task)}
              />
              {mode === 'chat' && conversation.turnCount > 1 && (
                <span className="pointer-events-none absolute right-2 top-2 rounded-full border border-white/70 bg-gray-900/70 px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm backdrop-blur dark:border-white/10">
                  {conversation.turnCount} 轮
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  )
}

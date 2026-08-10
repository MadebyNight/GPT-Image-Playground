import { useEffect, useMemo, useRef, useState } from 'react'
import type { TaskRecord } from '../types'
import { cancelAgentTask, subscribeAgentProgress, type AgentProgressEvent, type AgentToolStatus } from '../lib/agentExecutor'
import AgentImagePreview from './AgentImagePreview'
import TaskDetailContent from './TaskDetailContent'
import { ChevronDownIcon } from './icons'

interface AgentMainWorkspaceProps {
  task: TaskRecord | null
  /** 同一 Agent 会话的任务，按创建时间升序。未传入时兼容旧调用方。 */
  conversationTasks?: TaskRecord[]
}

interface AgentSessionView {
  taskId: string
  prompt: string
  assistantText: string
  toolStatus: AgentToolStatus | null
  toolMessage: string
  partialImages: string[]
  doneImageCount: number | null
  revisedPrompts: string[]
  error: string | null
  stream: boolean
}

function createSessionFromTask(task: TaskRecord): AgentSessionView {
  return {
    taskId: task.id,
    prompt: task.prompt,
    assistantText: task.agentAssistantText?.trim() ?? '',
    toolStatus: task.status === 'running' ? 'in_progress' : task.status === 'done' ? 'completed' : null,
    toolMessage: task.status === 'running' ? '正在等待 Agent 工具调用结果' : task.status === 'done' ? '图像工具调用完成' : '',
    partialImages: [],
    doneImageCount: task.status === 'done' ? task.outputImages.length : null,
    revisedPrompts: task.revisedPromptByImage ? Object.values(task.revisedPromptByImage) : [],
    error: task.error,
    stream: true,
  }
}

function mergeSessionWithTask(task: TaskRecord, session: AgentSessionView | undefined): AgentSessionView {
  const fromTask = createSessionFromTask(task)
  if (!session) return fromTask

  const persistedAssistantText = fromTask.assistantText
  return {
    ...fromTask,
    ...session,
    assistantText: persistedAssistantText.length > session.assistantText.length
      ? persistedAssistantText
      : session.assistantText,
    toolStatus: task.status === 'done' ? 'completed' : session.toolStatus ?? fromTask.toolStatus,
    toolMessage: task.status === 'done' && !session.toolMessage ? fromTask.toolMessage : session.toolMessage,
    revisedPrompts: session.revisedPrompts.length ? session.revisedPrompts : fromTask.revisedPrompts,
    error: session.error ?? task.error,
  }
}

function applyAgentEvent(session: AgentSessionView | undefined, event: AgentProgressEvent, fallbackTaskId: string | null): AgentSessionView | undefined {
  const taskId = event.taskId ?? session?.taskId ?? fallbackTaskId
  if (!taskId) return session

  if (event.type === 'task_created') {
    return {
      taskId: event.taskId,
      prompt: event.prompt,
      assistantText: '',
      toolStatus: 'queued',
      toolMessage: event.stream ? '已提交给 Agent，等待流式响应' : '已提交给 Agent，等待完整响应',
      partialImages: [],
      doneImageCount: null,
      revisedPrompts: [],
      error: null,
      stream: event.stream,
    }
  }

  const current = session ?? {
    taskId,
    prompt: '',
    assistantText: '',
    toolStatus: null,
    toolMessage: '',
    partialImages: [],
    doneImageCount: null,
    revisedPrompts: [],
    error: null,
    stream: true,
  }

  if (event.type === 'assistant_delta') {
    return { ...current, assistantText: `${current.assistantText}${event.text}` }
  }
  if (event.type === 'tool_status') {
    return { ...current, toolStatus: event.status, toolMessage: event.message }
  }
  if (event.type === 'partial_image') {
    return { ...current, partialImages: [...current.partialImages, event.image] }
  }
  if (event.type === 'done') {
    return {
      ...current,
      toolStatus: 'completed',
      toolMessage: `生成完成，共 ${event.imageCount} 张图片`,
      doneImageCount: event.imageCount,
      assistantText: event.assistantText?.trim() || current.assistantText,
      revisedPrompts: event.revisedPrompts?.filter((item): item is string => Boolean(item?.trim())) ?? current.revisedPrompts,
    }
  }
  if (event.type === 'error') {
    return { ...current, error: event.message, toolMessage: event.message }
  }

  return current
}

function getFallbackAssistantText(task: TaskRecord): string {
  if (task.status === 'running') return '正在生成图片。'
  if (task.status === 'error') return task.error || '本轮生成未完成。'
  return task.outputImages.length ? '图片已生成。' : '本轮已完成。'
}

function getAssistantText(task: TaskRecord, session?: AgentSessionView): string {
  return session?.assistantText.trim() || task.agentAssistantText?.trim() || getFallbackAssistantText(task)
}

function getTaskStatusLabel(task: TaskRecord): string {
  if (task.status === 'running') return '生成中'
  if (task.status === 'error') return '执行失败'
  return '已完成'
}

function getTaskStatusColor(task: TaskRecord): string {
  if (task.status === 'running') return 'bg-blue-500'
  if (task.status === 'error') return 'bg-red-500'
  return 'bg-emerald-500'
}

interface AgentDisclosureProps {
  title: string
  meta?: string
  children: React.ReactNode
  testId: string
}

function AgentDisclosure({ title, meta, children, testId }: AgentDisclosureProps) {
  return (
    <details data-testid={testId} className="group rounded-xl border border-gray-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-gray-700 marker:content-none dark:text-gray-200 [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        <span className="flex items-center gap-2 text-xs font-normal text-gray-400 dark:text-gray-500">
          {meta}
          <ChevronDownIcon className="h-4 w-4 transition-transform duration-200 group-open:rotate-180" aria-hidden="true" />
        </span>
      </summary>
      <div className="border-t border-gray-100 px-4 py-4 dark:border-white/[0.08]">{children}</div>
    </details>
  )
}

function DeferredTaskDetail({ task }: { task: TaskRecord }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <details
      data-testid="agent-task-detail"
      className="group rounded-xl border border-gray-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-gray-700 marker:content-none dark:text-gray-200 [&::-webkit-details-marker]:hidden">
        <span>查看图片与任务操作</span>
        <ChevronDownIcon className="h-4 w-4 text-gray-400 transition-transform duration-200 group-open:rotate-180" aria-hidden="true" />
      </summary>
      {expanded && (
        <div className="border-t border-gray-100 p-3 dark:border-white/[0.08]">
          <TaskDetailContent task={task} presentation="workspace" />
        </div>
      )}
    </details>
  )
}

export default function LegacyAgentMainWorkspace({ task, conversationTasks }: AgentMainWorkspaceProps) {
  const [sessions, setSessions] = useState<Record<string, AgentSessionView>>({})
  const fallbackTaskIdRef = useRef(task?.id ?? null)
  fallbackTaskIdRef.current = task?.id ?? null
  const activeSession = useMemo(
    () => task ? mergeSessionWithTask(task, sessions[task.id]) : null,
    [sessions, task],
  )
  const threadTasks = useMemo(
    () => conversationTasks?.length ? conversationTasks : task ? [task] : [],
    [conversationTasks, task],
  )

  useEffect(() => {
    return subscribeAgentProgress((event) => {
      const explicitTaskId = event.type === 'task_created' ? event.taskId : event.taskId
      setSessions((current) => {
        const taskId = explicitTaskId ?? fallbackTaskIdRef.current
        if (!taskId) return current
        const next = applyAgentEvent(current[taskId], event, taskId)
        return next ? { ...current, [taskId]: next } : current
      })
    })
  }, [])

  if (!task) {
    return (
      <section className="flex h-full min-h-[28rem] items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-white/70 p-6 text-center dark:border-white/[0.08] dark:bg-gray-900/70" aria-labelledby="agent-workspace-title">
        <div>
          <h2 id="agent-workspace-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">工作区</h2>
          <p className="mt-2 max-w-sm text-sm leading-6 text-gray-500 dark:text-gray-400">
            输入提示词开始一段新的对话，或从左侧历史继续已有会话。
          </p>
        </div>
      </section>
    )
  }

  const previewImageId = task.outputImages[0]
  const previewFallbackSrc = activeSession?.partialImages[activeSession.partialImages.length - 1] ?? ''
  const revisedPrompts = activeSession?.revisedPrompts ?? []
  const extraOutputImageIds = task.outputImages.slice(1)
  const hasExecutionDetails = Boolean(
    activeSession?.toolMessage ||
    revisedPrompts.length ||
    extraOutputImageIds.length ||
    activeSession?.partialImages.length,
  )
  const assistantResponseText = getAssistantText(task, activeSession ?? undefined)
  const executionError = activeSession?.error || task.error

  return (
    <section className="h-full min-h-0 overflow-y-auto rounded-2xl border border-gray-200 bg-white p-4 sm:p-6 dark:border-white/[0.08] dark:bg-gray-900" aria-labelledby="agent-workspace-title">
      <h2 id="agent-workspace-title" className="sr-only">当前 Agent 工作区</h2>
      <div className="mx-auto w-full max-w-[42rem] space-y-3 py-1 sm:py-3">
        <article data-agent-latest-response className="rounded-2xl border border-gray-200 bg-gray-50 p-4 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.04]">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
            <span className={`h-2 w-2 rounded-full ${getTaskStatusColor(task)}`} aria-hidden="true" />
            <span>Agent</span>
            <span className="text-gray-400 dark:text-gray-500">· {getTaskStatusLabel(task)}</span>
          </div>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-gray-700 dark:text-gray-200">
            {assistantResponseText}
          </p>
          {task.status === 'running' && (
            <button
              type="button"
              data-agent-cancel-task={task.id}
              className="mt-3 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-500/10"
              onClick={() => { cancelAgentTask(task.id) }}
            >
              取消生成
            </button>
          )}
          {(previewImageId || previewFallbackSrc || task.status === 'running') && (
            <AgentImagePreview
              imageId={previewImageId}
              fallbackSrc={previewFallbackSrc}
              alt="本轮生成结果预览"
              className="mx-auto mt-4 h-56 w-full max-w-md sm:h-64"
            />
          )}
          {executionError && executionError !== assistantResponseText && (
            <p className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
              {executionError}
            </p>
          )}
        </article>

        <AgentDisclosure
          testId="agent-full-thread"
          title="完整对话"
          meta={`${threadTasks.length} 轮`}
        >
          <div className="space-y-4">
            {threadTasks.map((threadTask, index) => (
              <article key={threadTask.id} data-agent-thread-turn={threadTask.id} className="rounded-xl bg-gray-50 p-3 dark:bg-white/[0.03]">
                <div className="text-xs font-medium text-gray-400 dark:text-gray-500">
                  第 {threadTask.agentTurn ?? index + 1} 轮
                </div>
                <div className="mt-2 rounded-xl bg-blue-500 px-3 py-2 text-sm leading-6 text-white">
                  {threadTask.prompt || '（无提示词）'}
                </div>
                <div className="mt-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm leading-6 text-gray-700 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-200">
                  {getAssistantText(threadTask, threadTask.id === task.id ? activeSession ?? undefined : undefined)}
                </div>
              </article>
            ))}
          </div>
        </AgentDisclosure>

        {hasExecutionDetails && (
          <AgentDisclosure
            testId="agent-execution-details"
            title="执行详情"
            meta={task.status === 'running' ? '进行中' : '按需查看'}
          >
            <div className="space-y-4 text-sm">
              {activeSession?.toolMessage && (
                <div className="rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300">
                  <span className="font-medium">工具状态：</span>{activeSession.toolMessage}
                </div>
              )}
              {revisedPrompts.length > 0 && (
                <section className="rounded-xl border border-amber-100 bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
                  <h3 className="font-medium">工具实际使用的提示词</h3>
                  <div className="mt-2 space-y-2">
                    {revisedPrompts.map((prompt, index) => (
                      <p key={`${prompt}-${index}`} className="whitespace-pre-wrap">{prompt}</p>
                    ))}
                  </div>
                </section>
              )}
              {extraOutputImageIds.length > 0 && (
                <section>
                  <h3 className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">其余生成图片</h3>
                  <div className="grid grid-cols-2 gap-2">
                    {extraOutputImageIds.map((imageId, index) => (
                      <AgentImagePreview
                        key={imageId}
                        imageId={imageId}
                        alt={`本轮其余生成图片 ${index + 2}`}
                        className="aspect-square w-full"
                      />
                    ))}
                  </div>
                </section>
              )}
              {activeSession?.partialImages.length ? (
                <section>
                  <h3 className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">流式预览</h3>
                  <div className="grid grid-cols-2 gap-2">
                    {activeSession.partialImages.slice(-4).map((image, index) => (
                      <AgentImagePreview
                        key={`${image.slice(0, 32)}-${index}`}
                        fallbackSrc={image}
                        alt="Agent 流式预览"
                        className="aspect-square w-full"
                      />
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          </AgentDisclosure>
        )}

        <DeferredTaskDetail task={task} />
      </div>
    </section>
  )
}

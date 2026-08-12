import { useEffect, useMemo, useRef, useState } from 'react'
import type { TaskRecord } from '../types'
import { cancelAgentTask, subscribeAgentProgress, type AgentProgressEvent, type AgentToolStatus } from '../lib/agentExecutor'
import { useStore } from '../store'
import AgentConversationStream from './AgentConversationStream'
import AgentExecutionDetails from './AgentExecutionDetails'
import AgentImagePreview from './AgentImagePreview'
import AgentResultReply, { type AgentResultImage, type AgentResultStatus } from './AgentResultReply'
import TaskActionRow from './TaskActionRow'

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

function getTaskStatus(task: TaskRecord, session: AgentSessionView): AgentResultStatus {
  if (task.status === 'running') {
    return { label: getTaskStatusLabel(task), detail: session.toolStatus === 'queued' ? '等待响应' : undefined, tone: 'progress' }
  }
  if (task.status === 'error') return { label: getTaskStatusLabel(task), tone: 'error' }
  return {
    label: getTaskStatusLabel(task),
    detail: task.elapsed == null ? undefined : `${Math.max(0, Math.round(task.elapsed / 1000))} 秒`,
    tone: 'success',
  }
}

function getResultImages(task: TaskRecord, session: AgentSessionView): AgentResultImage[] {
  if (task.outputImages.length) {
    return task.outputImages.map((id, index) => ({
      id,
      alt: `第 ${task.agentTurn ?? 1} 轮生成结果 ${index + 1}`,
    }))
  }

  const partialImage = session.partialImages[session.partialImages.length - 1]
  if (partialImage) {
    return [{
      fallbackSrc: partialImage,
      alt: 'Agent 流式预览',
      interactive: false,
    }]
  }

  return task.status === 'running'
    ? [{ alt: '等待 Agent 图片输出', interactive: false }]
    : []
}

export default function LegacyAgentMainWorkspace({ task, conversationTasks }: AgentMainWorkspaceProps) {
  const [sessions, setSessions] = useState<Record<string, AgentSessionView>>({})
  const setLightboxImageId = useStore((state) => state.setLightboxImageId)
  const fallbackTaskIdRef = useRef(task?.id ?? null)
  fallbackTaskIdRef.current = task?.id ?? null
  const threadTasks = useMemo(
    () => {
      const tasks = conversationTasks?.length ? conversationTasks : task ? [task] : []
      return [...tasks].sort((left, right) => {
        const turnDifference = (left.agentTurn ?? Number.MAX_SAFE_INTEGER) - (right.agentTurn ?? Number.MAX_SAFE_INTEGER)
        return turnDifference || left.createdAt - right.createdAt || left.id.localeCompare(right.id)
      })
    },
    [conversationTasks, task],
  )
  const threadViews = useMemo(
    () => threadTasks.map((threadTask) => ({
      task: threadTask,
      session: mergeSessionWithTask(threadTask, sessions[threadTask.id]),
    })),
    [sessions, threadTasks],
  )
  const conversationKey = threadTasks[0]?.agentConversationId ?? task?.agentConversationId ?? task?.id ?? null
  const contentVersion = useMemo(
    () => threadViews.map(({ task: threadTask, session }) => [
      threadTask.id,
      threadTask.status,
      threadTask.outputImages.join(','),
      session.assistantText,
      session.toolStatus,
      session.toolMessage,
      session.partialImages.map((image) => image.length).join(','),
      session.revisedPrompts.join('\n'),
      session.error,
    ].join(':')).join('|'),
    [threadViews],
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

  return (
    <section className="flex h-full min-h-0 flex-col bg-white dark:bg-gray-900" aria-labelledby="agent-workspace-title">
      <h2 id="agent-workspace-title" className="sr-only">当前 Agent 工作区</h2>
      <AgentConversationStream
        conversationKey={conversationKey}
        contentVersion={contentVersion}
        emptyState={(
          <div className="flex min-h-[28rem] flex-1 items-center justify-center text-center">
            <div>
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">工作区</h3>
              <p className="mt-2 max-w-sm text-sm leading-6 text-gray-500 dark:text-gray-400">
                输入提示词开始一段新的对话，或从左侧历史继续已有会话。
              </p>
            </div>
          </div>
        )}
      >
        {threadViews.length ? <div className="space-y-8">
          {threadViews.map(({ task: threadTask, session }, index) => {
            const assistantText = getAssistantText(threadTask, session)
            const executionError = session.error || threadTask.error
            const revisedPrompt = session.revisedPrompts.length
              ? session.revisedPrompts.map((prompt, promptIndex) => (
                <p key={`${prompt}-${promptIndex}`}>{prompt}</p>
              ))
              : undefined
            const partialPreviews = session.partialImages.length ? (
              <div className="flex flex-wrap gap-2">
                {session.partialImages.slice(-4).map((image, partialIndex) => (
                      <AgentImagePreview
                        key={`${image.slice(0, 32)}-${partialIndex}`}
                        fallbackSrc={image}
                        alt="Agent 流式预览"
                        interactive={false}
                      />
                ))}
              </div>
            ) : undefined

            return (
              <div key={threadTask.id} data-agent-conversation-turn={threadTask.id} className="space-y-4">
                <div className="flex justify-end">
                  <div
                    data-agent-user-message={threadTask.id}
                    data-selectable-text
                    className="max-w-[min(84%,36rem)] whitespace-pre-wrap rounded-2xl rounded-br-md bg-blue-500 px-4 py-3 text-sm leading-6 text-white"
                  >
                    {threadTask.prompt || '（无提示词）'}
                  </div>
                </div>
                <div className="flex justify-start">
                  <AgentResultReply
                    className="w-full max-w-[40rem]"
                    assistantText={<span data-selectable-text>{assistantText}</span>}
                    status={getTaskStatus(threadTask, session)}
                    errorMessage={executionError}
                    recoveryActions={threadTask.status === 'running' ? (
                      <button
                        type="button"
                        data-agent-cancel-task={threadTask.id}
                        className="inline-flex min-h-11 items-center rounded-xl border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-500/10"
                        onClick={() => { cancelAgentTask(threadTask.id) }}
                      >
                        取消生成
                      </button>
                    ) : undefined}
                    images={getResultImages(threadTask, session)}
                    onOpenImage={(imageId, imageIds) => setLightboxImageId(imageId, imageIds)}
                    taskActionRow={threadTask.status === 'running' ? undefined : (
                      <TaskActionRow task={threadTask} presentation="agent" />
                    )}
                    executionDetails={(
                      <AgentExecutionDetails
                        prompt={threadTask.prompt || '（无提示词）'}
                        revisedPrompt={revisedPrompt}
                        toolMessages={session.toolMessage}
                        partialPreviews={partialPreviews}
                      />
                    )}
                  />
                </div>
                {index < threadViews.length - 1 ? (
                  <div className="h-px bg-gray-100 dark:bg-white/[0.06]" aria-hidden="true" />
                ) : null}
              </div>
            )
          })}
        </div> : undefined}
      </AgentConversationStream>
    </section>
  )
}

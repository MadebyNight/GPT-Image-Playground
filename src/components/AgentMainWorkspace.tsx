import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  cancelUnifiedAgentTask,
  retryUnifiedAgentTask,
  subscribeAgentProgress,
  type AgentProgressEvent,
  type AgentToolStatus,
} from '../lib/agentExecutor'
import { useStore } from '../store'
import type {
  RestrictedAgentExecution,
  RestrictedAgentExecutionActionStatus,
  RestrictedAgentPlan,
  RestrictedAgentToolAction,
  TaskRecord,
  ToolAgentPlanV3,
} from '../types'
import AgentConversationStream from './AgentConversationStream'
import AgentExecutionDetails from './AgentExecutionDetails'
import AgentImagePreview from './AgentImagePreview'
import AgentPlanCard from './AgentPlanCard'
import AgentResultReply, {
  type AgentResultImage,
  type AgentResultStatus,
  type AgentResultStatusTone,
} from './AgentResultReply'
import TaskActionRow from './TaskActionRow'

interface AgentMainWorkspaceProps {
  task: TaskRecord | null
  /** 同一 Agent 会话的任务，按 turn/创建时间升序；旧记录也只读展示。 */
  conversationTasks?: TaskRecord[]
}

interface AgentSessionView {
  taskId: string
  prompt: string
  assistantText: string
  toolStatus: AgentToolStatus | null
  toolMessage: string
  partialImages: string[]
  revisedPrompts: string[]
  error: string | null
}

const ACTION_LABELS: Record<RestrictedAgentToolAction['type'], string> = {
  'image.generate': '图片生成',
  'image.edit': '图片编辑',
  'image.transform': '严格尺寸处理',
  'metadata.assert': '输出规格校验',
}

function isV3Plan(plan: RestrictedAgentPlan | undefined): plan is ToolAgentPlanV3 {
  return plan?.schemaVersion === 3
}

function createSessionFromTask(task: TaskRecord): AgentSessionView {
  return {
    taskId: task.id,
    prompt: task.prompt,
    assistantText: task.agentAssistantText?.trim() ?? '',
    toolStatus: task.status === 'running' ? 'in_progress' : task.status === 'done' ? 'completed' : null,
    toolMessage: task.status === 'running' ? '正在生成图片' : task.status === 'done' ? '图片已生成' : '',
    partialImages: [],
    revisedPrompts: task.revisedPromptByImage ? Object.values(task.revisedPromptByImage) : [],
    error: task.error,
  }
}

function mergeSessionWithTask(task: TaskRecord, session: AgentSessionView | undefined): AgentSessionView {
  const fromTask = createSessionFromTask(task)
  if (!session) return fromTask
  return {
    ...fromTask,
    ...session,
    assistantText: fromTask.assistantText.length > session.assistantText.length
      ? fromTask.assistantText
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
      toolMessage: event.stream ? '已提交，等待流式响应' : '已提交，等待响应',
      partialImages: [],
      revisedPrompts: [],
      error: null,
    }
  }

  const current = session ?? {
    taskId,
    prompt: '',
    assistantText: '',
    toolStatus: null,
    toolMessage: '',
    partialImages: [],
    revisedPrompts: [],
    error: null,
  }
  if (event.type === 'assistant_delta') return { ...current, assistantText: `${current.assistantText}${event.text}` }
  if (event.type === 'tool_status') return { ...current, toolStatus: event.status, toolMessage: event.message }
  if (event.type === 'partial_image') return { ...current, partialImages: [...current.partialImages, event.image] }
  if (event.type === 'done') {
    return {
      ...current,
      toolStatus: 'completed',
      toolMessage: `生成完成，共 ${event.imageCount} 张图片`,
      assistantText: event.assistantText?.trim() || current.assistantText,
      revisedPrompts: event.revisedPrompts?.filter((item): item is string => Boolean(item?.trim())) ?? current.revisedPrompts,
    }
  }
  if (event.type === 'error') return { ...current, error: event.message, toolMessage: event.message }
  return current
}

function getFallbackAssistantText(task: TaskRecord): string {
  if (task.status === 'running') return '正在生成图片。'
  if (task.status === 'error') return task.error || '本轮生成未完成。'
  return task.outputImages.length ? '图片已生成。' : task.agentAssistantText?.trim() || '本轮已完成。'
}

function getAssistantText(task: TaskRecord, session?: AgentSessionView): string {
  return session?.assistantText.trim() || task.agentAssistantText?.trim() || getFallbackAssistantText(task)
}

function getTaskStatus(task: TaskRecord, session: AgentSessionView): AgentResultStatus {
  if (task.status === 'running') {
    return { label: '生成中', detail: session.toolStatus === 'queued' ? '等待响应' : undefined, tone: 'progress' }
  }
  if (task.status === 'error') return { label: '执行失败', tone: 'error' }
  return {
    label: '已完成',
    detail: task.elapsed == null ? undefined : `${Math.max(0, Math.round(task.elapsed / 1000))} 秒`,
    tone: 'success',
  }
}

function getResultImages(task: TaskRecord, session: AgentSessionView): AgentResultImage[] {
  if (task.outputImages.length) {
    return task.outputImages.map((id, index) => ({ id, alt: `第 ${task.agentTurn ?? 1} 轮生成结果 ${index + 1}` }))
  }
  const partialImage = session.partialImages[session.partialImages.length - 1]
  if (partialImage) return [{ fallbackSrc: partialImage, alt: 'Agent 流式预览', interactive: false }]
  return task.status === 'running' ? [{ alt: '等待 Agent 图片输出', interactive: false }] : []
}

function getActionStatusText(type: RestrictedAgentToolAction['type'], status: RestrictedAgentExecutionActionStatus) {
  if (status === 'executing') {
    if (type === 'image.generate') return '正在生成图片'
    if (type === 'image.edit') return '正在编辑图片'
    if (type === 'image.transform') return '正在严格处理尺寸'
    return '正在校验输出规格'
  }
  if (status === 'queued') return `等待${ACTION_LABELS[type]}`
  if (status === 'completed') return `${ACTION_LABELS[type]}已完成`
  if (status === 'cancelled') return `${ACTION_LABELS[type]}已取消`
  if (status === 'failed_unknown') return `${ACTION_LABELS[type]}状态不确定`
  return `${ACTION_LABELS[type]}失败`
}

function getExecutionTone(status: RestrictedAgentExecution['status'] | undefined): AgentResultStatusTone {
  if (status === 'completed') return 'success'
  if (status === 'failed' || status === 'failed_unknown' || status === 'cancelled') return 'error'
  return 'progress'
}

function getPipelineStatus(task: TaskRecord, execution: RestrictedAgentExecution | null): AgentResultStatus {
  if (!execution) {
    return task.status === 'error'
      ? { label: '严格输出未完成', tone: 'error' }
      : { label: '正在分析执行方式', tone: 'progress' }
  }
  const currentAction = execution.actions?.find((action) => action.status === 'executing')
    ?? execution.actions?.find((action) => action.status === 'queued')
  const detail = currentAction ? getActionStatusText(currentAction.type, currentAction.status) : undefined
  const label = execution.status === 'completed'
    ? '严格输出已完成'
    : execution.status === 'cancelled'
      ? '执行已取消'
      : execution.status === 'failed_unknown'
        ? '执行状态不确定'
        : execution.status === 'failed'
          ? '严格输出未完成'
          : '自动执行中'
  return { label, detail, tone: getExecutionTone(execution.status) }
}

function Parameters({ task }: { task: TaskRecord }) {
  return (
    <dl className="grid gap-2 text-xs sm:grid-cols-2">
      <div><dt className="text-gray-400 dark:text-gray-500">尺寸</dt><dd>{task.params.size}</dd></div>
      <div><dt className="text-gray-400 dark:text-gray-500">质量</dt><dd>{task.params.quality}</dd></div>
      <div><dt className="text-gray-400 dark:text-gray-500">格式</dt><dd>{task.params.output_format}</dd></div>
      <div><dt className="text-gray-400 dark:text-gray-500">数量</dt><dd>{task.params.n}</dd></div>
    </dl>
  )
}

function ActionProgress({ plan, execution }: { plan: ToolAgentPlanV3; execution: RestrictedAgentExecution | null }) {
  return (
    <ul className="space-y-1">
      {plan.actions.map((action, actionIndex) => {
        const status = execution?.actions?.find((item) => item.actionIndex === actionIndex)?.status
          ?? (execution?.status === 'completed' ? 'completed' : execution?.status === 'cancelled' ? 'cancelled' : 'queued')
        return <li key={`${action.type}-${actionIndex}`}>{ACTION_LABELS[action.type]} · {getActionStatusText(action.type, status)}</li>
      })}
    </ul>
  )
}

function TurnDetails({ task, plan, execution, session }: { task: TaskRecord; plan?: ToolAgentPlanV3; execution: RestrictedAgentExecution | null; session: AgentSessionView }) {
  const referenceImageIds = task.inputImageIds
  const revisedPrompt = session.revisedPrompts.length
    ? session.revisedPrompts.map((prompt, index) => <p key={`${prompt}-${index}`}>{prompt}</p>)
    : undefined
  const run = execution || task.agentExecutionId ? (
    <dl className="grid gap-2 text-xs sm:grid-cols-2">
      {task.agentExecutionId ? <div><dt className="text-gray-400 dark:text-gray-500">执行编号</dt><dd className="break-all font-mono">{task.agentExecutionId}</dd></div> : null}
      {execution?.status ? <div><dt className="text-gray-400 dark:text-gray-500">当前状态</dt><dd>{getPipelineStatus(task, execution).label}</dd></div> : null}
    </dl>
  ) : undefined

  return (
    <AgentExecutionDetails
      prompt={task.agentOriginalRequest || task.prompt || '（无提示词）'}
      revisedPrompt={revisedPrompt}
      references={referenceImageIds.length ? (
        <div className="flex flex-wrap gap-2">
          {referenceImageIds.map((imageId, index) => (
            <AgentImagePreview key={imageId} imageId={imageId} imageIds={referenceImageIds} alt={`参考图 ${index + 1}`} />
          ))}
        </div>
      ) : undefined}
      parameters={<Parameters task={task} />}
      run={run}
      actionProgress={plan ? <ActionProgress plan={plan} execution={execution} /> : undefined}
      partialPreviews={session.partialImages.length ? (
        <div className="flex flex-wrap gap-2">
          {session.partialImages.slice(-4).map((image, index) => <AgentImagePreview key={`${image.slice(0, 32)}-${index}`} fallbackSrc={image} alt="Agent 流式预览" interactive={false} />)}
        </div>
      ) : undefined}
      rawImageUrls={task.rawImageUrls}
      rawResponse={task.rawResponsePayload}
    />
  )
}

function UserMessage({ task }: { task: TaskRecord }) {
  return (
    <div className="flex justify-end">
      <div data-agent-user-message={task.id} data-selectable-text className="max-w-[min(84%,36rem)] whitespace-pre-wrap rounded-2xl rounded-br-md bg-blue-500 px-4 py-3 text-sm leading-6 text-white">
        {task.agentOriginalRequest || task.prompt || '（无提示词）'}
      </div>
    </div>
  )
}

function ResponseTurn({ task, session }: { task: TaskRecord; session: AgentSessionView }) {
  const plan = isV3Plan(task.agentPlanSnapshot) ? task.agentPlanSnapshot : undefined
  const execution = task.agentExecutionSnapshot ?? null
  const isReadOnlyCompatibility = task.origin === 'restricted-agent' || task.origin === 'openshop'
  const isPipeline = Boolean(plan)
  const terminalActionRow = !isReadOnlyCompatibility && task.status !== 'running'
    ? <TaskActionRow task={task} presentation="agent" />
    : undefined
  const recoveryActions = !isReadOnlyCompatibility && !isPipeline && task.status === 'running' ? (
    <button
      type="button"
      aria-label="取消执行"
      className="inline-flex min-h-11 items-center rounded-xl border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-500/10"
      onClick={() => { void cancelUnifiedAgentTask(task) }}
    >
      取消执行
    </button>
  ) : !isReadOnlyCompatibility && !isPipeline && task.status === 'error' ? (
    <button
      type="button"
      aria-label="重试"
      className="inline-flex min-h-11 items-center rounded-xl bg-blue-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-600"
      onClick={() => { void retryUnifiedAgentTask(task) }}
    >
      重试
    </button>
  ) : undefined

  return (
    <div data-agent-conversation-turn={task.id} className="space-y-4">
      <UserMessage task={task} />
      <div className="flex justify-start">
        <div className="w-full max-w-[42rem]">
          {isPipeline && plan ? (
            <>
              <AgentPlanCard
                plan={plan}
                execution={execution}
                onCancel={task.status === 'running' ? () => { void cancelUnifiedAgentTask(task) } : undefined}
                onRetry={task.status === 'error' ? () => { void retryUnifiedAgentTask(task) } : undefined}
              />
              {(task.status === 'done' || task.status === 'error' || task.outputImages.length) ? (
                <div className="mt-4">
                  <AgentResultReply
                    status={getPipelineStatus(task, execution)}
                    errorMessage={task.error || execution?.error?.message}
                    images={getResultImages(task, session)}
                    onOpenImage={(imageId, imageIds) => useStore.getState().setLightboxImageId(imageId, imageIds)}
                    taskActionRow={terminalActionRow}
                    executionDetails={<TurnDetails task={task} plan={plan} execution={execution} session={session} />}
                  />
                </div>
              ) : (
                <div className="mt-4"><TurnDetails task={task} plan={plan} execution={execution} session={session} /></div>
              )}
            </>
          ) : task.agentPlanSnapshot ? (
            <>
              <AgentResultReply
                assistantText={<span data-selectable-text>{getAssistantText(task, session)}</span>}
                status={getTaskStatus(task, session)}
                errorMessage={session.error || task.error}
                images={getResultImages(task, session)}
                onOpenImage={(imageId, imageIds) => useStore.getState().setLightboxImageId(imageId, imageIds)}
                executionDetails={<TurnDetails task={task} execution={execution} session={session} />}
              />
              <div className="mt-4"><AgentPlanCard plan={task.agentPlanSnapshot} execution={execution} /></div>
            </>
          ) : (
            <AgentResultReply
              assistantText={<span data-selectable-text>{getAssistantText(task, session)}</span>}
              status={getTaskStatus(task, session)}
              errorMessage={session.error || task.error}
              recoveryActions={recoveryActions}
              images={getResultImages(task, session)}
              onOpenImage={(imageId, imageIds) => useStore.getState().setLightboxImageId(imageId, imageIds)}
              taskActionRow={terminalActionRow}
              executionDetails={<TurnDetails task={task} execution={execution} session={session} />}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export default function AgentMainWorkspace({ task, conversationTasks }: AgentMainWorkspaceProps) {
  const [sessions, setSessions] = useState<Record<string, AgentSessionView>>({})
  const fallbackTaskIdRef = useRef(task?.id ?? null)
  fallbackTaskIdRef.current = task?.id ?? null
  const threadTasks = useMemo(() => {
    const source = conversationTasks?.length ? conversationTasks : task ? [task] : []
    return [...source].sort((left, right) => {
      const turnDifference = (left.agentTurn ?? Number.MAX_SAFE_INTEGER) - (right.agentTurn ?? Number.MAX_SAFE_INTEGER)
      return turnDifference || left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    })
  }, [conversationTasks, task])
  const threadViews = useMemo(
    () => threadTasks.map((threadTask) => ({ task: threadTask, session: mergeSessionWithTask(threadTask, sessions[threadTask.id]) })),
    [sessions, threadTasks],
  )
  const conversationKey = task?.agentConversationId ?? task?.id ?? null
  const contentVersion = useMemo(
    () => threadViews.map(({ task: threadTask, session }) => [
      threadTask.id,
      threadTask.status,
      threadTask.outputImages.join(','),
      threadTask.agentExecutionSnapshot?.status,
      threadTask.agentExecutionSnapshot?.actions?.map((action) => `${action.actionIndex}:${action.status}`).join(','),
      session.assistantText,
      session.toolStatus,
      session.partialImages.map((image) => image.length).join(','),
      session.error,
    ].join(':')).join('|'),
    [threadViews],
  )

  useEffect(() => subscribeAgentProgress((event) => {
    setSessions((current) => {
      const taskId = event.taskId ?? fallbackTaskIdRef.current
      if (!taskId) return current
      const next = applyAgentEvent(current[taskId], event, taskId)
      return next ? { ...current, [taskId]: next } : current
    })
  }), [])

  return (
    <section className="flex h-full min-h-0 flex-col bg-white dark:bg-gray-900" aria-labelledby="agent-workspace-title">
      <h2 id="agent-workspace-title" className="sr-only">当前 Agent 工作区</h2>
      <AgentConversationStream
        conversationKey={conversationKey}
        contentVersion={contentVersion}
        emptyState={(
          <div className="flex min-h-[28rem] flex-1 items-center justify-center text-center">
            <div>
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Agent 工作区</h3>
              <p className="mt-2 max-w-sm text-sm leading-6 text-gray-500 dark:text-gray-400">输入图片需求开始新的对话，或从左侧历史继续已有会话。</p>
            </div>
          </div>
        )}
      >
        {threadViews.length ? (
          <div className="space-y-8">
            {threadViews.map(({ task: threadTask, session }, index) => (
              <div key={threadTask.id}>
                <ResponseTurn task={threadTask} session={session} />
                {index < threadViews.length - 1 ? <div className="mt-8 h-px bg-gray-100 dark:bg-white/[0.06]" aria-hidden="true" /> : null}
              </div>
            ))}
          </div>
        ) : undefined}
      </AgentConversationStream>
    </section>
  )
}

import type { ReactNode } from 'react'
import { getRestrictedAgentPlanOperation } from '../lib/restrictedAgentApi'
import { useRestrictedAgentStore } from '../restrictedAgentStore'
import { getComposerDraftSnapshot, useStore } from '../store'
import type {
  AgentMode,
  OpenShopToolLocalRun,
  OpenShopToolLocalRunStatus,
  RestrictedAgentExecution,
  RestrictedAgentExecutionStatus,
  RestrictedAgentPlan,
  TaskRecord,
} from '../types'
import AgentConversationStream from './AgentConversationStream'
import AgentExecutionDetails from './AgentExecutionDetails'
import AgentImagePreview from './AgentImagePreview'
import AgentPlanCard from './AgentPlanCard'
import AgentResultReply, {
  type AgentResultStatus,
} from './AgentResultReply'
import LegacyAgentMainWorkspace from './LegacyAgentMainWorkspace'
import TaskActionRow from './TaskActionRow'

interface AgentMainWorkspaceProps {
  mode: AgentMode
  chatTask: TaskRecord | null
  chatConversationTasks?: TaskRecord[]
  toolTask: TaskRecord | null
}

const STATUS_LABELS: Record<RestrictedAgentExecutionStatus, string> = {
  queued: '已进入受限执行队列',
  executing: 'Gateway 正在执行计划',
  completed: '执行完成',
  failed: '执行失败',
  cancelled: '执行已取消',
  failed_unknown: '执行状态不确定，不会自动重试',
}

const LOCAL_RUN_STATUS_LABELS: Record<OpenShopToolLocalRunStatus, string> = {
  running: 'OpenShop 正在当前浏览器执行',
  exported: 'OpenShop 已导出结果，等待保存',
  saving: '正在保存 OpenShop 导出结果',
  completed: 'OpenShop 编辑与本地保存已完成',
  cancelled: 'OpenShop 本地执行已取消',
  failed: 'OpenShop 本地执行失败',
  interrupted: 'OpenShop 本地执行被页面刷新或关闭中断',
  expired: 'OpenShop 临时导出结果已过期',
}

const recoveryButtonClassName = 'inline-flex min-h-11 items-center rounded-xl border border-current px-3 py-2 text-sm font-medium transition hover:bg-current/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500'

function getExecutionTone(status: RestrictedAgentExecutionStatus): AgentResultStatus['tone'] {
  if (status === 'completed') return 'success'
  if (status === 'failed' || status === 'failed_unknown' || status === 'cancelled') return 'error'
  return 'progress'
}

function getLocalRunTone(status: OpenShopToolLocalRunStatus): AgentResultStatus['tone'] {
  if (status === 'completed') return 'success'
  if (status === 'exported') return 'warning'
  if (status === 'cancelled' || status === 'failed' || status === 'interrupted' || status === 'expired') return 'error'
  return 'progress'
}

function getTaskStatus(task: TaskRecord): AgentResultStatus {
  if (task.status === 'done') {
    return {
      label: task.origin === 'openshop' ? 'OpenShop 编辑完成' : '任务完成',
      detail: task.elapsed == null ? undefined : `耗时 ${(task.elapsed / 1000).toFixed(1)} 秒`,
      tone: 'success',
    }
  }
  if (task.status === 'error') {
    const localStatus = task.agentLocalRunStatus
    return {
      label: localStatus ? LOCAL_RUN_STATUS_LABELS[localStatus] : '任务失败',
      tone: 'error',
    }
  }
  return { label: '任务执行中，等待状态恢复', tone: 'progress' }
}

function getPlanPrompt(plan: RestrictedAgentPlan | null): string | undefined {
  if (!plan) return undefined
  const operation = getRestrictedAgentPlanOperation(plan)
  if (operation.type === 'image.generate' || operation.type === 'image.edit') {
    return operation.generation.exactPrompt
  }
  return undefined
}

function PlanDetails({ plan }: { plan: RestrictedAgentPlan }) {
  const operation = getRestrictedAgentPlanOperation(plan)
  return (
    <dl className="grid gap-2 text-xs sm:grid-cols-2">
      <div>
        <dt className="text-gray-400 dark:text-gray-500">摘要</dt>
        <dd className="mt-0.5 text-gray-700 dark:text-gray-200">{plan.summary}</dd>
      </div>
      <div>
        <dt className="text-gray-400 dark:text-gray-500">Operation</dt>
        <dd className="mt-0.5 font-mono text-gray-700 dark:text-gray-200">{operation.type}</dd>
      </div>
      <div>
        <dt className="text-gray-400 dark:text-gray-500">计划</dt>
        <dd className="mt-0.5 font-mono text-gray-700 dark:text-gray-200">{plan.id} · v{plan.version}</dd>
      </div>
      <div>
        <dt className="text-gray-400 dark:text-gray-500">策略</dt>
        <dd className="mt-0.5 font-mono text-gray-700 dark:text-gray-200">{plan.policyVersion}</dd>
      </div>
    </dl>
  )
}

function ParameterDetails({ task }: { task: TaskRecord }) {
  const source = [task.apiProfileName, task.apiModel].filter(Boolean).join(' · ')
  return (
    <dl className="grid gap-2 text-xs sm:grid-cols-2">
      <div><dt className="text-gray-400 dark:text-gray-500">尺寸</dt><dd>{task.params.size}</dd></div>
      <div><dt className="text-gray-400 dark:text-gray-500">质量</dt><dd>{task.params.quality}</dd></div>
      <div><dt className="text-gray-400 dark:text-gray-500">格式</dt><dd>{task.params.output_format}</dd></div>
      <div><dt className="text-gray-400 dark:text-gray-500">数量</dt><dd>{task.params.n}</dd></div>
      {source ? <div className="sm:col-span-2"><dt className="text-gray-400 dark:text-gray-500">来源</dt><dd>{source}</dd></div> : null}
    </dl>
  )
}

function RunDetails({
  task,
  execution,
  localRun,
}: {
  task: TaskRecord | null
  execution: RestrictedAgentExecution | null
  localRun: OpenShopToolLocalRun | null
}) {
  const executionId = execution?.id ?? task?.agentExecutionId
  const executionStatus = execution?.status
  const runId = localRun?.id ?? task?.agentRunId ?? task?.agentLocalRunId
  const runStatus = localRun?.status ?? task?.agentLocalRunStatus
  const saveStatus = localRun?.saveStatus ?? task?.agentLocalSaveStatus
  if (!executionId && !runId) return null

  return (
    <dl className="grid gap-2 text-xs sm:grid-cols-2">
      {executionId ? (
        <div>
          <dt className="text-gray-400 dark:text-gray-500">执行 ID</dt>
          <dd className="break-all font-mono">{executionId}{executionStatus ? ` · ${executionStatus}` : ''}</dd>
        </div>
      ) : null}
      {runId ? (
        <div>
          <dt className="text-gray-400 dark:text-gray-500">本地 Run</dt>
          <dd className="break-all font-mono">{runId}{runStatus ? ` · ${runStatus}` : ''}{saveStatus ? ` / ${saveStatus}` : ''}</dd>
        </div>
      ) : null}
    </dl>
  )
}

interface ToolExecutionDetailsProps {
  task: TaskRecord | null
  plan: RestrictedAgentPlan | null
  execution: RestrictedAgentExecution | null
  localRun: OpenShopToolLocalRun | null
  onOpenImage: (imageId: string, imageIds: string[]) => void
}

function ToolExecutionDetails({ task, plan, execution, localRun, onOpenImage }: ToolExecutionDetailsProps) {
  const referenceImageIds = task?.inputImageIds ?? []
  const prompt = task?.agentOriginalRequest || plan?.originalRequest || task?.prompt
  const revisedPrompt = task?.outputImages
    .map((imageId) => task.revisedPromptByImage?.[imageId]?.trim())
    .find(Boolean) || getPlanPrompt(plan)
  const runDetails = <RunDetails task={task} execution={execution} localRun={localRun} />

  return (
    <AgentExecutionDetails
      prompt={prompt}
      revisedPrompt={revisedPrompt && revisedPrompt !== prompt ? revisedPrompt : undefined}
      references={referenceImageIds.length ? (
        <div className="flex flex-wrap gap-2">
          {referenceImageIds.map((imageId, index) => (
            <AgentImagePreview
              key={imageId}
              imageId={imageId}
              imageIds={referenceImageIds}
              alt={`参考图 ${index + 1}`}
              onOpen={onOpenImage}
            />
          ))}
        </div>
      ) : undefined}
      parameters={task ? <ParameterDetails task={task} /> : undefined}
      plan={plan ? <PlanDetails plan={plan} /> : undefined}
      run={runDetails}
      rawImageUrls={task?.rawImageUrls}
      rawResponse={task?.rawResponsePayload}
    />
  )
}

interface LiveReplyState {
  status?: AgentResultStatus
  assistantText?: ReactNode
  errorMessage?: ReactNode
  recoveryActions?: ReactNode
}

function getLiveReplyState({
  phase,
  execution,
  localRun,
  error,
  planningText,
  retryOpenShopSave,
  returnToEditing,
  cancelExecution,
}: {
  phase: string
  execution: RestrictedAgentExecution | null
  localRun: OpenShopToolLocalRun | null
  error: string | null
  planningText: string
  retryOpenShopSave: () => Promise<string | null>
  returnToEditing: () => void
  cancelExecution: () => Promise<void>
}): LiveReplyState {
  const streamedText = planningText.trim() || undefined
  if (phase === 'planning') {
    return {
      assistantText: streamedText || '正在规划执行步骤…',
      status: { label: '规划中', tone: 'progress' },
    }
  }

  if (phase === 'awaiting_confirmation' || phase === 'confirming') {
    return {
      assistantText: streamedText,
      status: { label: '正在启动执行', tone: 'progress' },
    }
  }

  if (execution) {
    const terminal = ['failed', 'failed_unknown', 'cancelled'].includes(execution.status)
    return {
      assistantText: streamedText,
      status: {
        label: STATUS_LABELS[execution.status],
        detail: `执行 ID：${execution.id}`,
        tone: getExecutionTone(execution.status),
      },
      errorMessage: execution.error?.message || (terminal ? error : undefined),
      recoveryActions: execution.status === 'queued' || execution.status === 'executing' ? (
        <button type="button" className={recoveryButtonClassName} onClick={() => { void cancelExecution() }}>
          尝试取消
        </button>
      ) : terminal ? (
        <button type="button" className={recoveryButtonClassName} onClick={returnToEditing}>
          返回修改并重新规划
        </button>
      ) : undefined,
    }
  }

  if (localRun) {
    const terminal = ['cancelled', 'failed', 'interrupted', 'expired'].includes(localRun.status)
    return {
      assistantText: streamedText,
      status: {
        label: LOCAL_RUN_STATUS_LABELS[localRun.status],
        detail: `本地 Run：${localRun.id}`,
        tone: getLocalRunTone(localRun.status),
      },
      errorMessage: localRun.error?.message || (localRun.status === 'exported' || terminal ? error : undefined),
      recoveryActions: localRun.status === 'exported' ? (
        <button type="button" className={recoveryButtonClassName} onClick={() => { void retryOpenShopSave() }}>
          仅重试保存
        </button>
      ) : localRun.status === 'saving' ? (
        <button type="button" className={recoveryButtonClassName} onClick={() => { void cancelExecution() }}>
          取消保存
        </button>
      ) : terminal ? (
        <button type="button" className={recoveryButtonClassName} onClick={returnToEditing}>
          返回修改并重新规划
        </button>
      ) : undefined,
    }
  }

  if (phase === 'expired' || phase === 'stale') {
    return {
      assistantText: streamedText,
      status: { label: phase === 'expired' ? '计划已过期' : '计划已过时', tone: 'warning' },
      errorMessage: error || (phase === 'expired'
        ? '计划已过期。返回修改后重新生成计划，旧计划不会被执行。'
        : '输入已变化。返回修改后重新生成计划，旧计划不会被确认。'),
    }
  }

  if (phase === 'failed' && error) {
    return {
      assistantText: streamedText,
      status: { label: 'Agent 流程失败', tone: 'error' },
      errorMessage: error,
      recoveryActions: (
        <button type="button" className={recoveryButtonClassName} onClick={returnToEditing}>
          返回修改
        </button>
      ),
    }
  }

  return {}
}

function RestrictedAgentMainWorkspace({ task }: { task: TaskRecord | null }) {
  const phase = useRestrictedAgentStore((state) => state.phase)
  const livePlan = useRestrictedAgentStore((state) => state.plan)
  const liveExecution = useRestrictedAgentStore((state) => state.execution)
  const flowTaskId = useRestrictedAgentStore((state) => state.taskId)
  const liveError = useRestrictedAgentStore((state) => state.error)
  const planningText = useRestrictedAgentStore((state) => state.planningText)
  const liveLocalRun = useRestrictedAgentStore((state) => state.localRun)
  const retryOpenShopSave = useRestrictedAgentStore((state) => state.retryOpenShopSave)
  const returnToEditing = useRestrictedAgentStore((state) => state.returnToEditing)
  const cancelExecution = useRestrictedAgentStore((state) => state.cancelExecution)
  const setLightboxImageId = useStore((state) => state.setLightboxImageId)

  const liveFlowActive = phase !== 'idle'
  const unboundLiveFlow = liveFlowActive && !flowTaskId
  const liveFlowMatchesSelection = liveFlowActive && (unboundLiveFlow || !task || task.id === flowTaskId)
  const displayedTask = unboundLiveFlow ? null : task
  const plan = liveFlowMatchesSelection ? livePlan ?? displayedTask?.agentPlanSnapshot ?? null : displayedTask?.agentPlanSnapshot ?? null
  const execution = liveFlowMatchesSelection ? liveExecution : null
  const localRun = liveFlowMatchesSelection ? liveLocalRun : null
  const hasLiveFlow = liveFlowMatchesSelection
  const hasConversation = Boolean(displayedTask || hasLiveFlow)
  const liveDraftRequest = hasLiveFlow && !displayedTask && !livePlan
    ? getComposerDraftSnapshot('tool').prompt.trim()
    : ''
  const requestText = hasLiveFlow
    ? livePlan?.originalRequest || displayedTask?.agentOriginalRequest || displayedTask?.prompt || liveDraftRequest
    : displayedTask?.agentOriginalRequest || displayedTask?.prompt || ''
  const showPlanCard = Boolean(hasLiveFlow && livePlan && (phase === 'expired' || phase === 'stale'))
  const liveReply = hasLiveFlow
    ? getLiveReplyState({
        phase,
        execution,
        localRun,
        error: liveError,
        planningText,
        retryOpenShopSave,
        returnToEditing,
        cancelExecution,
      })
    : {}
  const taskStatus = displayedTask ? getTaskStatus(displayedTask) : undefined
  const replyStatus = liveReply.status ?? taskStatus
  const errorMessage = liveReply.errorMessage ?? (displayedTask?.status === 'error' ? displayedTask.error : undefined)
  const completedImages = displayedTask?.status === 'done'
    ? displayedTask.outputImages.map((imageId, index) => ({ id: imageId, alt: `生成结果 ${index + 1}` }))
    : []
  const taskActionRow = displayedTask?.status === 'done'
    ? <TaskActionRow task={displayedTask} presentation="agent" />
    : undefined
  const details = plan || displayedTask || execution || localRun ? (
    <ToolExecutionDetails
      task={displayedTask}
      plan={plan}
      execution={execution}
      localRun={localRun}
      onOpenImage={setLightboxImageId}
    />
  ) : undefined
  const contentVersion = [
    phase,
    displayedTask?.status,
    displayedTask?.outputImages.length,
    execution?.status,
    localRun?.status,
    localRun?.saveStatus,
    planningText,
    errorMessage ? String(errorMessage) : '',
  ].join(':')

  return (
    <AgentConversationStream
      conversationKey={displayedTask?.id ?? flowTaskId ?? 'tool-new'}
      contentVersion={contentVersion}
      className="h-full"
      emptyState={(
        <section className="flex min-h-[28rem] flex-1 items-center justify-center text-center" aria-labelledby="tool-agent-workspace-title">
          <div>
            <h2 id="tool-agent-workspace-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">Tool Agent 工作区</h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-gray-500 dark:text-gray-400">
              输入图片需求后，Agent 会展示规划说明并自动执行。
            </p>
          </div>
        </section>
      )}
    >
      {hasConversation ? (
        <div className="flex flex-1 flex-col justify-end gap-6 pb-4">
          {requestText ? (
            <div data-agent-tool-user-message data-selectable-text className="flex justify-end">
              <div className="max-w-[min(84%,36rem)] whitespace-pre-wrap rounded-2xl bg-blue-500 px-4 py-3 text-sm leading-6 text-white shadow-sm">
                {requestText}
              </div>
            </div>
          ) : null}

          <div
            data-agent-tool-response
            data-openshop-local-run-status={localRun?.status}
            data-selectable-text
            className="flex justify-start"
          >
            <div className="w-full min-w-0 max-w-[42rem]">
              {liveReply.assistantText || replyStatus || errorMessage || completedImages.length || taskActionRow ? (
                <AgentResultReply
                  assistantText={liveReply.assistantText}
                  status={replyStatus}
                  errorMessage={errorMessage}
                  recoveryActions={liveReply.recoveryActions}
                  images={completedImages}
                  onOpenImage={setLightboxImageId}
                  taskActionRow={taskActionRow}
                  executionDetails={!showPlanCard ? details : undefined}
                />
              ) : null}

              {showPlanCard && livePlan ? (
                <div className="mt-3">
                  <AgentPlanCard
                    plan={livePlan}
                    stale={phase === 'stale'}
                    onReturnToEditing={returnToEditing}
                  />
                  {details ? <div className="mt-4">{details}</div> : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </AgentConversationStream>
  )
}

export default function AgentMainWorkspace(props: AgentMainWorkspaceProps) {
  const { mode, chatTask, chatConversationTasks, toolTask } = props
  return (
    <>
      <div
        id="agent-chat-panel"
        data-agent-main-mode="chat"
        className={mode === 'chat' ? 'h-full min-h-0' : 'hidden'}
        aria-hidden={mode !== 'chat'}
      >
        <LegacyAgentMainWorkspace task={chatTask} conversationTasks={chatConversationTasks} />
      </div>
      <div
        id="agent-tool-panel"
        data-agent-main-mode="tool"
        className={mode === 'tool' ? 'h-full min-h-0' : 'hidden'}
        aria-hidden={mode !== 'tool'}
      >
        <RestrictedAgentMainWorkspace task={toolTask} />
      </div>
    </>
  )
}

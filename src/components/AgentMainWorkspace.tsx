import { useMemo } from 'react'
import { useRestrictedAgentStore } from '../restrictedAgentStore'
import type { AgentMode, OpenShopToolLocalRunStatus, RestrictedAgentExecutionStatus, TaskRecord } from '../types'
import AgentPlanCard from './AgentPlanCard'
import LegacyAgentMainWorkspace from './LegacyAgentMainWorkspace'
import TaskDetailContent from './TaskDetailContent'

interface AgentMainWorkspaceProps {
  mode: AgentMode
  chatTask: TaskRecord | null
  chatConversationTasks?: TaskRecord[]
  toolTask: TaskRecord | null
}

const STATUS_LABELS: Record<RestrictedAgentExecutionStatus, string> = {
  queued: '已进入受限执行队列',
  executing: 'Gateway 正在执行已确认计划',
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

function RestrictedAgentMainWorkspace({ task }: { task: TaskRecord | null }) {
  const phase = useRestrictedAgentStore((state) => state.phase)
  const plan = useRestrictedAgentStore((state) => state.plan)
  const execution = useRestrictedAgentStore((state) => state.execution)
  const flowTaskId = useRestrictedAgentStore((state) => state.taskId)
  const error = useRestrictedAgentStore((state) => state.error)
  const assetBindings = useRestrictedAgentStore((state) => state.assetBindings)
  const localRun = useRestrictedAgentStore((state) => state.localRun)
  const confirmAndExecute = useRestrictedAgentStore((state) => state.confirmAndExecute)
  const retryOpenShopSave = useRestrictedAgentStore((state) => state.retryOpenShopSave)
  const returnToEditing = useRestrictedAgentStore((state) => state.returnToEditing)
  const cancelExecution = useRestrictedAgentStore((state) => state.cancelExecution)

  const showPlanningFlow = phase === 'planning' || phase === 'awaiting_confirmation' || phase === 'confirming' || phase === 'expired' || phase === 'stale' || (phase === 'failed' && !execution && !localRun)
  const showExecutionFlow = Boolean((execution || localRun) && (!task || task.id === flowTaskId))
  const requestText = plan?.originalRequest || task?.agentOriginalRequest || task?.prompt || ''
  const planForTask = useMemo(() => plan ?? task?.agentPlanSnapshot ?? null, [plan, task?.agentPlanSnapshot])

  if (!task && !showPlanningFlow && !showExecutionFlow) {
    return (
      <section className="flex h-full min-h-[28rem] items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-white/70 p-6 text-center dark:border-white/[0.08] dark:bg-gray-900/70" aria-labelledby="tool-agent-workspace-title">
        <div>
          <h2 id="tool-agent-workspace-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">Tool Agent 工作区</h2>
          <p className="mt-2 max-w-md text-sm leading-6 text-gray-500 dark:text-gray-400">
            输入图片需求后先生成执行计划。你确认 Prompt、参数和步骤后，Gateway 才会调用图片接口。
          </p>
        </div>
      </section>
    )
  }

  return (
    <section className="h-full min-h-0 overflow-y-auto rounded-2xl border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-gray-900" aria-labelledby="tool-agent-workspace-title">
      <h2 id="tool-agent-workspace-title" className="sr-only">当前 Tool Agent 工作区</h2>
      <div className="mx-auto max-w-4xl space-y-4">
        {(showPlanningFlow || showExecutionFlow) && requestText && (
          <div className="flex justify-end">
            <div className="max-w-[84%] rounded-2xl bg-blue-500 px-4 py-3 text-sm leading-6 text-white shadow-sm">
              {requestText}
            </div>
          </div>
        )}

        {phase === 'planning' && (
          <div className="flex justify-start">
            <div className="rounded-2xl border border-gray-200 bg-gray-50 px-5 py-4 text-sm text-gray-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300">
              <div className="flex items-center gap-3">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                Planner 正在生成可审查的执行计划，此阶段不会调用图片接口。
              </div>
            </div>
          </div>
        )}

        {plan && (phase === 'awaiting_confirmation' || phase === 'confirming' || phase === 'expired' || phase === 'stale') && (
          <AgentPlanCard
            plan={plan}
            assetBindings={assetBindings}
            confirming={phase === 'confirming'}
            stale={phase === 'stale'}
            onConfirm={() => { void confirmAndExecute() }}
            onReturnToEditing={returnToEditing}
          />
        )}

        {phase === 'expired' && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
            计划已过期。返回修改后重新生成计划，旧计划不会被执行。
          </div>
        )}

        {phase === 'stale' && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
            输入已变化。返回修改后重新生成计划，旧计划不会被确认。
          </div>
        )}

        {showExecutionFlow && execution && (
          <div className="flex justify-start">
            <div className={`max-w-[88%] rounded-2xl border px-4 py-3 text-sm leading-6 ${
              execution.status === 'completed'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200'
                : ['failed', 'failed_unknown', 'cancelled'].includes(execution.status)
                  ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200'
                  : 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200'
            }`}>
              <div className="font-medium">{STATUS_LABELS[execution.status]}</div>
              <div className="mt-1 text-xs opacity-75">执行 ID：{execution.id}</div>
              {execution.error?.message && <p className="mt-2">{execution.error.message}</p>}
              {(execution.status === 'queued' || execution.status === 'executing') && (
                <button
                  type="button"
                  className="mt-3 rounded-lg border border-current px-3 py-1.5 text-xs font-medium opacity-80 hover:opacity-100"
                  onClick={() => { void cancelExecution() }}
                >
                  尝试取消
                </button>
              )}
            </div>
          </div>
        )}

        {showExecutionFlow && localRun && (
          <div className="flex justify-start">
            <div className={`max-w-[88%] rounded-2xl border px-4 py-3 text-sm leading-6 ${
              localRun.status === 'completed'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200'
                : ['cancelled', 'failed', 'interrupted', 'expired'].includes(localRun.status)
                  ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200'
                  : localRun.status === 'exported'
                    ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200'
                    : 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200'
            }`} data-openshop-local-run-status={localRun.status}>
              <div className="font-medium">{LOCAL_RUN_STATUS_LABELS[localRun.status]}</div>
              <div className="mt-1 text-xs opacity-75">本地 Run：{localRun.id}</div>
              {localRun.error?.message && <p className="mt-2">{localRun.error.message}</p>}
              {localRun.status === 'exported' && (
                <button
                  type="button"
                  className="mt-3 rounded-lg border border-current px-3 py-1.5 text-xs font-medium opacity-80 hover:opacity-100"
                  onClick={() => { void retryOpenShopSave() }}
                >
                  仅重试保存
                </button>
              )}
              {localRun.status === 'saving' && (
                <button
                  type="button"
                  className="mt-3 rounded-lg border border-current px-3 py-1.5 text-xs font-medium opacity-80 hover:opacity-100"
                  onClick={() => { void cancelExecution() }}
                >
                  取消保存
                </button>
              )}
              {['cancelled', 'failed', 'interrupted', 'expired'].includes(localRun.status) && (
                <button
                  type="button"
                  className="mt-3 rounded-lg border border-current px-3 py-1.5 text-xs font-medium opacity-80 hover:opacity-100"
                  onClick={returnToEditing}
                >
                  返回修改并重新规划
                </button>
              )}
            </div>
          </div>
        )}

        {error && phase === 'failed' && !execution?.error && !localRun && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200">
            <p>{error}</p>
            <button type="button" className="mt-3 rounded-lg border border-current px-3 py-1.5 text-xs font-medium" onClick={returnToEditing}>
              返回修改
            </button>
          </div>
        )}

        {task && (!showPlanningFlow || task.id === flowTaskId) && (
          <>
            {task.origin === 'restricted-agent' && planForTask && !showExecutionFlow && (
              <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300">
                已确认计划：{planForTask.summary} · 策略 {planForTask.policyVersion}
              </div>
            )}
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-3 dark:border-white/[0.08] dark:bg-gray-950">
              <TaskDetailContent task={task} presentation="workspace" />
            </div>
          </>
        )}
      </div>
    </section>
  )
}

export default function AgentMainWorkspace(props: AgentMainWorkspaceProps) {
  const { mode, chatTask, chatConversationTasks, toolTask } = props
  return (
    <>
      <div
        data-agent-main-mode="chat"
        className={mode === 'chat' ? 'h-full min-h-0' : 'hidden'}
        aria-hidden={mode !== 'chat'}
      >
        <LegacyAgentMainWorkspace task={chatTask} conversationTasks={chatConversationTasks} />
      </div>
      <div
        data-agent-main-mode="tool"
        className={mode === 'tool' ? 'h-full min-h-0' : 'hidden'}
        aria-hidden={mode !== 'tool'}
      >
        <RestrictedAgentMainWorkspace task={toolTask} />
      </div>
    </>
  )
}

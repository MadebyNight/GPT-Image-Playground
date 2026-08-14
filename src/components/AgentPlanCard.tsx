import { useId } from 'react'
import { getRestrictedAgentPlanOperation } from '../lib/restrictedAgentApi'
import type {
  RestrictedAgentExecution,
  RestrictedAgentExecutionActionStatus,
  RestrictedAgentPlan,
  RestrictedAgentToolAction,
  ToolAgentPlanV3,
} from '../types'

interface AgentPlanCardProps {
  plan: RestrictedAgentPlan
  execution?: RestrictedAgentExecution | null
  onCancel?: () => void
  onRetry?: () => void
}

const ACTION_LABELS: Record<RestrictedAgentToolAction['type'], string> = {
  'image.generate': '图片生成',
  'image.edit': '图片编辑',
  'image.transform': '严格尺寸处理',
  'metadata.assert': '输出规格校验',
}

function getActionStatusText(type: RestrictedAgentToolAction['type'], status: RestrictedAgentExecutionActionStatus) {
  const label = ACTION_LABELS[type]
  if (status === 'executing') {
    if (type === 'image.generate') return '正在生成图片'
    if (type === 'image.edit') return '正在编辑图片'
    if (type === 'image.transform') return '正在严格处理尺寸'
    return '正在校验输出规格'
  }
  if (status === 'queued') return `等待${label}`
  if (status === 'completed') return `${label}已完成`
  if (status === 'cancelled') return `${label}已取消`
  if (status === 'failed_unknown') return `${label}状态不确定`
  return `${label}失败`
}

function getActionStatus(execution: RestrictedAgentExecution | null | undefined, actionIndex: number): RestrictedAgentExecutionActionStatus {
  return execution?.actions?.find((action) => action.actionIndex === actionIndex)?.status
    ?? (execution?.status === 'completed' ? 'completed' : execution?.status === 'cancelled' ? 'cancelled' : 'queued')
}

function getExecutionStatusText(execution: RestrictedAgentExecution | null | undefined) {
  if (!execution) return '正在分析执行方式'
  if (execution.status === 'queued') return '已排队，等待开始执行'
  if (execution.status === 'executing') return '正在执行自动 action 链'
  if (execution.status === 'completed') return '执行完成'
  if (execution.status === 'cancelled') return '执行已取消'
  if (execution.status === 'failed_unknown') return '执行状态不确定'
  return '执行失败'
}

function formatFinalOutputSpec(plan: ToolAgentPlanV3) {
  const spec = plan.finalOutputSpec
  const size = spec.width && spec.height ? `${spec.width} × ${spec.height}` : '保持原始尺寸'
  const format = spec.outputFormat?.toUpperCase() ?? '保持原始格式'
  const fit = spec.fit ? ` · ${spec.fit}` : ''
  const position = spec.position ? ` · ${spec.position}` : ''
  return `${size} · ${format}${fit}${position}`
}

function getFinalPrompt(plan: ToolAgentPlanV3) {
  for (const action of plan.actions) {
    if (action.type === 'image.generate' || action.type === 'image.edit') return action.generation.exactPrompt
  }
  return null
}

function getInputRoleLabel(role: ToolAgentPlanV3['inputs'][number]['role']) {
  if (role === 'mask') return '遮罩'
  if (role === 'mask_target') return '遮罩目标图'
  return '参考图'
}

function getInputMimeLabel(mimeType: string) {
  return mimeType.startsWith('image/') ? mimeType.slice('image/'.length).toUpperCase() : '图片'
}

interface V3PlanCardProps {
  plan: ToolAgentPlanV3
  execution?: RestrictedAgentExecution | null
  onCancel?: () => void
  onRetry?: () => void
}

function V3PlanCard({ plan, execution, onCancel, onRetry }: V3PlanCardProps) {
  const titleId = `agent-plan-title-${useId()}`
  const promptTitleId = `agent-plan-prompt-${useId()}`
  const inputsTitleId = `agent-plan-inputs-${useId()}`
  const risksTitleId = `agent-plan-risks-${useId()}`
  const isRunning = execution?.status === 'queued' || execution?.status === 'executing'
  const canRetry = execution?.status === 'failed' || execution?.status === 'failed_unknown' || execution?.status === 'cancelled'
  const actionError = execution?.actions?.find((action) => action.error)?.error?.message
  const finalPrompt = getFinalPrompt(plan)

  return (
    <article data-agent-plan-card className="rounded-2xl border border-blue-200 bg-white p-5 shadow-sm dark:border-blue-500/25 dark:bg-gray-900" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-blue-500">自动执行</div>
          <h2 id={titleId} className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">{plan.summary}</h2>
          <p className="mt-1 text-xs text-gray-400">{getExecutionStatusText(execution)}</p>
        </div>
        <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">
          严格输出
        </span>
      </div>

      <section className="mt-5">
        <h3 className="text-xs font-medium uppercase tracking-wider text-gray-400">最终输出规格</h3>
        <p className="mt-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm leading-6 text-gray-700 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-200">
          {formatFinalOutputSpec(plan)}
        </p>
      </section>

      {finalPrompt ? (
        <section className="mt-5" aria-labelledby={promptTitleId}>
          <h3 id={promptTitleId} className="text-xs font-medium uppercase tracking-wider text-gray-400">最终提示词</h3>
          <p className="mt-2 whitespace-pre-wrap rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm leading-6 text-gray-700 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-200">
            {finalPrompt}
          </p>
        </section>
      ) : null}

      <section data-agent-plan-inputs className="mt-5" aria-labelledby={inputsTitleId}>
        <h3 id={inputsTitleId} className="text-xs font-medium uppercase tracking-wider text-gray-400">输入图片</h3>
        {plan.inputs.length > 0 ? (
          <ul className="mt-2 space-y-2" aria-label={`输入图片，共 ${plan.inputs.length} 张`}>
            {plan.inputs.map((input, inputIndex) => (
              <li
                key={`${input.role}-${inputIndex}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.04]"
              >
                <span className="font-medium text-gray-800 dark:text-gray-100">{getInputRoleLabel(input.role)} {inputIndex + 1}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400">{input.width} × {input.height} · {getInputMimeLabel(input.mimeType)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-400">
            本回合未附加输入图片。
          </p>
        )}
      </section>

      <section className="mt-5" aria-live="polite">
        <h3 className="text-xs font-medium uppercase tracking-wider text-gray-400">执行进度</h3>
        <ol className="mt-2 space-y-2">
          {plan.actions.map((action, actionIndex) => {
            const status = getActionStatus(execution, actionIndex)
            return (
              <li
                key={`${action.type}-${actionIndex}`}
                data-agent-action-status={status}
                className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.04]"
              >
                <span className="font-medium text-gray-800 dark:text-gray-100">{ACTION_LABELS[action.type]}</span>
                <span className={`text-xs ${status === 'failed' || status === 'failed_unknown' ? 'text-red-600 dark:text-red-300' : status === 'executing' ? 'text-blue-600 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400'}`}>
                  {getActionStatusText(action.type, status)}
                </span>
              </li>
            )
          })}
        </ol>
      </section>

      {execution?.error?.message || actionError ? (
        <p role="alert" className="mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
          {actionError ?? execution?.error?.message}
        </p>
      ) : null}

      {plan.assumptions.length > 0 && (
        <section className="mt-4 rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
          <h3 className="font-medium">处理假设</h3>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {plan.assumptions.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      )}

      {plan.warnings.length > 0 && (
        <section className="mt-3 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200" aria-labelledby={risksTitleId}>
          <h3 id={risksTitleId} className="font-medium">处理风险</h3>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {plan.warnings.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      )}

      {(isRunning && onCancel) || (canRetry && onRetry) ? (
        <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-gray-100 pt-4 dark:border-white/[0.08]">
          {isRunning && onCancel ? (
            <button
              type="button"
              aria-label="取消执行"
              className="rounded-xl border border-red-200 px-4 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-500/10"
              onClick={onCancel}
            >
              取消执行
            </button>
          ) : null}
          {canRetry && onRetry ? (
            <button
              type="button"
              aria-label="重试"
              className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-600"
              onClick={onRetry}
            >
              重试
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function LegacyPlanCard({ plan }: { plan: Exclude<RestrictedAgentPlan, ToolAgentPlanV3> }) {
  const titleId = `agent-plan-title-${useId()}`
  const operation = getRestrictedAgentPlanOperation(plan)
  const generation = operation.type === 'image.generate' || operation.type === 'image.edit'
    ? operation.generation
    : null
  const label = operation.type === 'image.generate'
    ? '图片生成'
    : operation.type === 'image.edit'
      ? '图片编辑'
      : '确定性编辑'

  return (
    <article data-agent-plan-card className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-white/[0.08] dark:bg-gray-900" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-gray-400">只读兼容</div>
          <h2 id={titleId} className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">{plan.summary}</h2>
          <p className="mt-1 text-xs text-gray-400">旧版计划仅供查看，不提供新的执行入口。</p>
        </div>
        <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600 dark:bg-white/[0.06] dark:text-gray-300">{label}</span>
      </div>
      {generation ? (
        <section className="mt-5">
          <h3 className="text-xs font-medium uppercase tracking-wider text-gray-400">已冻结的图片描述</h3>
          <p className="mt-2 whitespace-pre-wrap rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm leading-6 text-gray-700 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-200">{generation.exactPrompt}</p>
        </section>
      ) : null}
    </article>
  )
}

export default function AgentPlanCard({ plan, execution, onCancel, onRetry }: AgentPlanCardProps) {
  if (plan.schemaVersion === 3) {
    return <V3PlanCard plan={plan} execution={execution} onCancel={onCancel} onRetry={onRetry} />
  }
  return <LegacyPlanCard plan={plan} />
}

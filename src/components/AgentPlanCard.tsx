import { getRestrictedAgentPlanOperation } from '../lib/restrictedAgentApi'
import type { OpenShopCanvasCommand } from '../lib/openshopBridge'
import type { RestrictedAgentAssetBinding, RestrictedAgentPlan } from '../types'

interface AgentPlanCardProps {
  plan: RestrictedAgentPlan
  assetBindings?: RestrictedAgentAssetBinding[]
  confirming?: boolean
  stale?: boolean
  onConfirm: () => void
  onReturnToEditing: () => void
}

function formatCommand(command: OpenShopCanvasCommand) {
  switch (command.id) {
    case 'canvas.crop':
      return `裁剪：x=${command.args.x}，y=${command.args.y}，${command.args.width} × ${command.args.height}`
    case 'canvas.rotate':
      return `旋转：${command.args.degrees}°`
    case 'canvas.flip':
      return `翻转：${command.args.axis === 'h' ? '水平' : '垂直'}`
    case 'canvas.flatten':
      return '扁平化画布'
  }
}

export default function AgentPlanCard({
  plan,
  assetBindings = [],
  confirming = false,
  stale = false,
  onConfirm,
  onReturnToEditing,
}: AgentPlanCardProps) {
  const expiresAt = new Date(plan.expiresAt)
  const expired = expiresAt.getTime() <= Date.now()
  const operation = getRestrictedAgentPlanOperation(plan)
  const openShopOperation = operation.type === 'openshop.edit' ? operation : null
  const generation = operation.type === 'image.generate' || operation.type === 'image.edit'
    ? operation.generation
    : null
  const openShopBinding = openShopOperation
    ? assetBindings.find((binding) => binding.gatewayAssetId === openShopOperation.inputAssetId)
    : null
  const openShopBindingReady = Boolean(
    openShopBinding?.browserImageId && openShopBinding.role === 'reference',
  )
  const confirmationDisabled = confirming || expired || stale || Boolean(openShopOperation && !openShopBindingReady)
  const badge = operation.type === 'image.generate'
    ? '图片生成'
    : operation.type === 'image.edit'
      ? '图片编辑'
      : 'OpenShop 编辑'

  return (
    <article className="rounded-2xl border border-blue-200 bg-white p-5 shadow-sm dark:border-blue-500/25 dark:bg-gray-900" aria-labelledby="agent-plan-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-blue-500">
            {stale ? '计划已过时' : '等待确认'}
          </div>
          <h2 id="agent-plan-title" className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">{plan.summary}</h2>
          <p className="mt-1 text-xs text-gray-400">
            {plan.schemaVersion === 2 ? 'Schema v2' : '兼容计划 v1'} · 计划版本 {plan.version} · {expired ? '已过期' : `有效至 ${expiresAt.toLocaleTimeString()}`}
          </p>
        </div>
        <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">
          {badge}
        </span>
      </div>

      <section className="mt-5">
        <h3 className="text-xs font-medium uppercase tracking-wider text-gray-400">单一 Operation</h3>
        <div className="mt-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 dark:border-white/[0.08] dark:bg-gray-950">
          <code className="text-sm font-semibold text-blue-600 dark:text-blue-300">{operation.type}</code>
        </div>
      </section>

      {generation && (
        <>
          <section className="mt-5">
            <h3 className="text-xs font-medium uppercase tracking-wider text-gray-400">最终执行 Prompt</h3>
            <p className="mt-2 whitespace-pre-wrap rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm leading-6 text-gray-700 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-200">
              {generation.exactPrompt}
            </p>
          </section>

          <section className="mt-5">
            <h3 className="text-xs font-medium uppercase tracking-wider text-gray-400">冻结参数</h3>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
              {[
                ['尺寸', generation.size],
                ['质量', generation.quality],
                ['格式', generation.outputFormat],
                ['压缩率', generation.outputCompression ?? '不适用'],
                ['数量', generation.imageCount],
                ['输入资源', plan.inputs.length],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-white/[0.04]">
                  <dt className="text-gray-400">{label}</dt>
                  <dd className="mt-1 font-medium text-gray-700 dark:text-gray-200">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </section>
        </>
      )}

      {openShopOperation && (
        <>
          <section className="mt-5">
            <h3 className="text-xs font-medium uppercase tracking-wider text-gray-400">冻结 Canvas 命令</h3>
            <ol className="mt-2 space-y-2">
              {openShopOperation.commands.map((command, index) => (
                <li key={`${command.id}-${index}`} className="rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:bg-white/[0.04] dark:text-gray-200">
                  <code className="mr-2 text-xs text-blue-600 dark:text-blue-300">{command.id}</code>
                  {formatCommand(command)}
                </li>
              ))}
            </ol>
          </section>
          <section className="mt-5">
            <h3 className="text-xs font-medium uppercase tracking-wider text-gray-400">输入来源</h3>
            <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
              <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-white/[0.04]">
                <dt className="text-gray-400">角色与顺序</dt>
                <dd className="mt-1 font-medium text-gray-700 dark:text-gray-200">
                  {openShopBinding ? `参考图 · 第 ${openShopBinding.ordinal + 1} 张` : '输入映射缺失'}
                </dd>
              </div>
              <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-white/[0.04]">
                <dt className="text-gray-400">来源</dt>
                <dd className="mt-1 font-medium text-gray-700 dark:text-gray-200">
                  {openShopBinding?.sourceTaskId ? '历史任务输出' : openShopBinding ? '当前浏览器输入' : 'binding 缺失'}
                </dd>
              </div>
            </dl>
          </section>
        </>
      )}

      {plan.webSearch && (
        <section className="mt-5">
          <h3 className="text-xs font-medium uppercase tracking-wider text-gray-400">联网参考</h3>
          {plan.webSearch.sources.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {plan.webSearch.sources.map((source) => (
                <li key={source.url} className="rounded-xl bg-gray-50 px-3 py-2 text-sm dark:bg-white/[0.04]">
                  <a href={source.url} target="_blank" rel="noreferrer" className="font-medium text-blue-600 hover:underline dark:text-blue-300">
                    {source.title}
                  </a>
                  <p className="mt-1 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{source.description}</p>
                  <span className="mt-1 block text-[11px] text-gray-400">{source.engine}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">已请求联网搜索，但未获得可用结果；本计划按离线信息生成。</p>
          )}
        </section>
      )}

      {plan.assumptions.length > 0 && (
        <section className="mt-5 rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
          <h3 className="font-medium">规划假设</h3>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {plan.assumptions.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      )}

      {plan.warnings.length > 0 && (
        <section className="mt-3 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200">
          <h3 className="font-medium">执行前提示</h3>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {plan.warnings.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      )}

      {openShopOperation && (
        <p className="mt-4 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-xs text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200">
          确认后将在当前浏览器创建一次性 OpenShop iframe。刷新或中断不会自动重放命令。
        </p>
      )}

      <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-gray-100 pt-4 dark:border-white/[0.08]">
        <button
          type="button"
          className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-white/[0.1] dark:text-gray-300 dark:hover:bg-white/[0.05]"
          onClick={onReturnToEditing}
          disabled={confirming}
        >
          返回修改
        </button>
        <button
          type="button"
          className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-white/[0.08]"
          onClick={onConfirm}
          disabled={confirmationDisabled}
        >
          {confirming
            ? '正在确认…'
            : stale
              ? '计划已过时'
              : expired
                ? '计划已过期'
                : openShopOperation && !openShopBindingReady
                  ? '输入映射无效'
                  : openShopOperation
                    ? '确认并在浏览器执行'
                    : '确认并执行'}
        </button>
      </div>
    </article>
  )
}

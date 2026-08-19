import type { ReactNode } from 'react'

export interface AgentExecutionDetailsProps {
  summaryLabel?: ReactNode
  defaultOpen?: boolean
  prompt?: ReactNode
  revisedPrompt?: ReactNode
  references?: ReactNode
  parameters?: ReactNode
  plan?: ReactNode
  run?: ReactNode
  toolMessages?: ReactNode
  partialPreviews?: ReactNode
  rawImageUrls?: readonly string[] | ReactNode
  rawResponse?: ReactNode
  className?: string
}

interface DetailSectionProps {
  label: string
  children: ReactNode
  code?: boolean
}

function hasContent(value: ReactNode): boolean {
  if (value == null || value === false) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

function DetailSection({ label, children, code = false }: DetailSectionProps) {
  return (
    <section className="min-w-0">
      <h4 className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-gray-400 dark:text-gray-500">
        {label}
      </h4>
      {code ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-gray-100 px-3 py-2 font-mono text-xs leading-5 text-gray-600 dark:bg-black/20 dark:text-gray-300">
          {children}
        </pre>
      ) : (
        <div className="whitespace-pre-wrap break-words text-sm leading-6 text-gray-600 dark:text-gray-300">
          {children}
        </div>
      )}
    </section>
  )
}

function sanitizeRawResponse(value: ReactNode): ReactNode {
  if (typeof value !== 'string') return value
  return value.replace(/"(b64_json|base64|data)":\s*"[^"]+"/g, '"$1": "<base64_data>"')
}

export default function AgentExecutionDetails({
  summaryLabel = '执行详情',
  defaultOpen = false,
  prompt,
  revisedPrompt,
  references,
  parameters,
  plan,
  run,
  toolMessages,
  partialPreviews,
  rawImageUrls,
  rawResponse,
  className = '',
}: AgentExecutionDetailsProps) {
  const rawImageUrlContent = Array.isArray(rawImageUrls)
    ? rawImageUrls.join('\n')
    : rawImageUrls

  return (
    <details
      data-agent-execution-details
      open={defaultOpen}
      className={`group rounded-xl border border-gray-200 bg-gray-50/70 dark:border-white/[0.08] dark:bg-white/[0.025] ${className}`}
    >
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-gray-600 marker:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:text-gray-300">
        {summaryLabel}
      </summary>
      <div className="grid gap-4 border-t border-gray-200 px-3 py-3 dark:border-white/[0.08]">
        {hasContent(prompt) ? <DetailSection label="用户 Prompt">{prompt}</DetailSection> : null}
        {hasContent(revisedPrompt) ? <DetailSection label="修订 Prompt">{revisedPrompt}</DetailSection> : null}
        {hasContent(references) ? <DetailSection label="参考图">{references}</DetailSection> : null}
        {hasContent(parameters) ? <DetailSection label="参数与来源">{parameters}</DetailSection> : null}
        {hasContent(plan) ? <DetailSection label="计划">{plan}</DetailSection> : null}
        {hasContent(run) ? <DetailSection label="执行与 Run">{run}</DetailSection> : null}
        {hasContent(toolMessages) ? <DetailSection label="Tool 消息">{toolMessages}</DetailSection> : null}
        {hasContent(partialPreviews) ? <DetailSection label="流式中间预览">{partialPreviews}</DetailSection> : null}
        {hasContent(rawImageUrlContent) ? (
          <DetailSection label="原始图片链接" code>{rawImageUrlContent}</DetailSection>
        ) : null}
        {hasContent(rawResponse) ? (
          <DetailSection label="原始响应" code>{sanitizeRawResponse(rawResponse)}</DetailSection>
        ) : null}
      </div>
    </details>
  )
}

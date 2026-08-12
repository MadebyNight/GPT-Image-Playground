import type { ReactNode } from 'react'
import AgentImagePreview, {
  type AgentImagePreviewState,
} from './AgentImagePreview'

export type AgentResultStatusTone = 'neutral' | 'progress' | 'success' | 'warning' | 'error'

export interface AgentResultStatus {
  label: ReactNode
  detail?: ReactNode
  tone?: AgentResultStatusTone
}

export interface AgentResultImage {
  id?: string
  fallbackSrc?: string
  alt: string
  interactive?: boolean
  previewState?: AgentImagePreviewState
  className?: string
}

export interface AgentResultReplyProps {
  assistantText?: ReactNode
  status?: AgentResultStatus
  errorMessage?: ReactNode
  recoveryActions?: ReactNode
  images?: readonly AgentResultImage[]
  onOpenImage?: (imageId: string, imageIds: string[]) => void
  /** 后续直接传入共享 TaskActionRow，结果回复本身不复制任务动作逻辑。 */
  taskActionRow?: ReactNode
  executionDetails?: ReactNode
  className?: string
}

const statusToneClassNames: Record<AgentResultStatusTone, string> = {
  neutral: 'bg-gray-400',
  progress: 'bg-blue-500',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  error: 'bg-red-500',
}

export default function AgentResultReply({
  assistantText,
  status,
  errorMessage,
  recoveryActions,
  images = [],
  onOpenImage,
  taskActionRow,
  executionDetails,
  className = '',
}: AgentResultReplyProps) {
  const imageIds = images.flatMap((image) => image.id ? [image.id] : [])

  return (
    <article
      data-agent-result-reply
      className={`min-w-0 max-w-full text-gray-800 dark:text-gray-100 ${className}`}
    >
      {assistantText ? (
        <div className="whitespace-pre-wrap text-sm leading-7 text-gray-700 dark:text-gray-200">
          {assistantText}
        </div>
      ) : null}

      {status ? (
        <div
          data-agent-result-status
          className="mt-2 flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500 dark:text-gray-400"
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusToneClassNames[status.tone ?? 'neutral']}`}
          />
          <span className="font-medium text-gray-600 dark:text-gray-300">{status.label}</span>
          {status.detail ? <span>{status.detail}</span> : null}
        </div>
      ) : null}

      {errorMessage ? (
        <div
          data-agent-error-summary
          role="alert"
          className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300"
        >
          {errorMessage}
        </div>
      ) : null}

      {recoveryActions ? (
        <div data-agent-recovery-actions className="mt-3 flex flex-wrap items-center gap-2">
          {recoveryActions}
        </div>
      ) : null}

      {images.length > 0 ? (
        <div data-agent-result-images className="mt-4 flex flex-wrap items-start gap-3">
          {images.map((image, index) => (
            <AgentImagePreview
              key={image.id ?? `${image.fallbackSrc?.slice(0, 48) ?? 'preview'}-${index}`}
              imageId={image.id}
              imageIds={imageIds}
              fallbackSrc={image.fallbackSrc}
              alt={image.alt}
              interactive={image.interactive}
              previewState={image.previewState}
              onOpen={onOpenImage}
              className={image.className}
            />
          ))}
        </div>
      ) : null}

      {taskActionRow ? (
        <div data-agent-task-action-row className="mt-3 flex flex-wrap items-center gap-2">
          {taskActionRow}
        </div>
      ) : null}

      {executionDetails ? (
        <div className="mt-4">{executionDetails}</div>
      ) : null}
    </article>
  )
}

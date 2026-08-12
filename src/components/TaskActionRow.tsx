import type { TaskRecord } from '../types'
import {
  editOutputs,
  removeTask,
  retryTask,
  reuseConfig,
  updateTaskInStore,
  useStore,
} from '../store'
import { getOpenShopHash } from '../lib/openshopRoute'
import { getRuntimeConfigState, isServerApiConfigEnabled } from '../lib/serverApiConfig'
import {
  EditIcon,
  ExternalLinkIcon,
  MaskEditIcon,
  ReuseIcon,
  RotateCcwIcon,
  StarIcon,
  TrashIcon,
} from './icons'

export type TaskActionPresentation = 'compact' | 'workspace' | 'modal' | 'agent'
type MaybePromise<T = void> = T | Promise<T>

interface TaskActionRowProps {
  task: TaskRecord
  presentation?: TaskActionPresentation
  outputImageId?: string
  alwaysShowRetry?: boolean
  onReuse?: () => MaybePromise
  onEditOutputs?: () => MaybePromise
  onAdvancedEdit?: (imageId: string, taskId: string) => MaybePromise
  onMaskEdit?: (imageId: string) => MaybePromise
  onRetry?: () => MaybePromise
  onDelete?: () => MaybePromise
  onRequestClose?: () => void
  onDeleteCommitted?: () => void
  className?: string
}

interface TaskActionCallbackDependencies extends TaskActionRowProps {
  setMaskEditorImageId: (imageId: string | null) => void
  setConfirmDialog: (dialog: {
    title: string
    message: string
    action: () => void
  }) => void
  focusInputEditor?: () => void
}

export function shouldShowTaskRetry(
  task: TaskRecord,
  presentation: TaskActionPresentation,
  alwaysShowRetry = false,
) {
  if (task.origin === 'restricted-agent' || task.origin === 'openshop') return false
  if (presentation !== 'compact') return true
  return (task.status === 'error' && !task.falRecoverable && !task.customRecoverable) || alwaysShowRetry
}

function focusComposerInput() {
  requestAnimationFrame(() => {
    const inputEditor = document.querySelector<HTMLElement>('[data-input-bar] [contenteditable="true"]')
    inputEditor?.focus()
    inputEditor?.scrollIntoView({ block: 'nearest' })
  })
}

export function createTaskActionCallbacks({
  task,
  presentation = 'workspace',
  outputImageId = task.outputImages[0] ?? '',
  onReuse,
  onEditOutputs,
  onAdvancedEdit,
  onMaskEdit,
  onRetry,
  onDelete,
  onRequestClose,
  onDeleteCommitted,
  setMaskEditorImageId,
  setConfirmDialog,
  focusInputEditor = focusComposerInput,
}: TaskActionCallbackDependencies) {
  const closeIfModal = () => {
    if (presentation === 'modal') onRequestClose?.()
  }
  const focusAfter = (action: () => MaybePromise) => {
    void Promise.resolve(action()).then(focusInputEditor)
    closeIfModal()
  }

  return {
    reuse: () => focusAfter(onReuse ?? (() => reuseConfig(task))),
    editOutputs: () => focusAfter(onEditOutputs ?? (() => editOutputs(task))),
    advancedEdit: () => {
      if (!outputImageId) return
      if (onAdvancedEdit) {
        void onAdvancedEdit(outputImageId, task.id)
      } else {
        window.location.hash = getOpenShopHash(outputImageId, task.id)
      }
      closeIfModal()
    },
    maskEdit: () => {
      if (!outputImageId) return
      if (onMaskEdit) void onMaskEdit(outputImageId)
      else setMaskEditorImageId(outputImageId)
      closeIfModal()
    },
    toggleFavorite: () => updateTaskInStore(task.id, { isFavorite: !task.isFavorite }),
    retry: () => {
      if (onRetry) void onRetry()
      else void retryTask(task)
      closeIfModal()
    },
    deleteTask: () => {
      closeIfModal()
      if (onDelete) {
        void onDelete()
        return
      }
      setConfirmDialog({
        title: '删除记录',
        message: '确定要删除这条记录吗？关联的图片资源也会被清理（如果没有其他任务引用）。',
        action: () => {
          void removeTask(task).then(onDeleteCommitted)
        },
      })
    },
  }
}

export default function TaskActionRow({
  task,
  presentation = 'workspace',
  outputImageId = task.outputImages[0] ?? '',
  alwaysShowRetry = false,
  onReuse,
  onEditOutputs,
  onAdvancedEdit,
  onMaskEdit,
  onRetry,
  onDelete,
  onRequestClose,
  onDeleteCommitted,
  className = '',
}: TaskActionRowProps) {
  const setMaskEditorImageId = useStore((state) => state.setMaskEditorImageId)
  const setConfirmDialog = useStore((state) => state.setConfirmDialog)
  const actions = createTaskActionCallbacks({
    task,
    presentation,
    outputImageId,
    alwaysShowRetry,
    onReuse,
    onEditOutputs,
    onAdvancedEdit,
    onMaskEdit,
    onRetry,
    onDelete,
    onRequestClose,
    onDeleteCommitted,
    setMaskEditorImageId,
    setConfirmDialog,
  })
  const hasOutput = Boolean(outputImageId)
  const showLabels = presentation !== 'compact'
  const runtimeConfigState = getRuntimeConfigState()
  const reuseLabel = isServerApiConfigEnabled() || runtimeConfigState.status !== 'ready'
    ? '复用输入与参数'
    : '复用配置'
  const rowClass = presentation === 'compact'
    ? 'mt-0.5 justify-end gap-1'
    : presentation === 'agent'
      ? 'justify-start gap-2 border-t border-gray-100 pt-3 dark:border-white/[0.08]'
      : 'gap-2 border-t border-gray-100 pt-4 dark:border-white/[0.08]'
  const compactButtonClass = 'inline-flex items-center justify-center rounded-md p-1.5 text-gray-400 transition disabled:cursor-not-allowed disabled:opacity-30'
  const textButtonClass = 'inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40'
  const buttonClass = (tone: 'blue' | 'green' | 'violet' | 'purple' | 'yellow' | 'red') => {
    if (presentation === 'compact') {
      const compactTones = {
        blue: 'hover:bg-blue-50 hover:text-blue-500 dark:hover:bg-blue-950/30',
        green: 'hover:bg-green-50 hover:text-green-500 dark:hover:bg-green-950/30',
        violet: 'hover:bg-violet-50 hover:text-violet-600 dark:hover:bg-violet-500/10 dark:hover:text-violet-300',
        purple: 'hover:bg-purple-50 hover:text-purple-600 dark:hover:bg-purple-500/10 dark:hover:text-purple-300',
        yellow: task.isFavorite ? 'text-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-500/10' : 'hover:bg-yellow-50 hover:text-yellow-400 dark:hover:bg-yellow-500/10',
        red: 'hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30',
      }
      return `${compactButtonClass} ${compactTones[tone]}`
    }
    const textTones = {
      blue: 'bg-blue-50 text-blue-600 hover:bg-blue-100 dark:bg-blue-500/10 dark:text-blue-400',
      green: 'bg-green-50 text-green-600 hover:bg-green-100 dark:bg-green-500/10 dark:text-green-400',
      violet: 'bg-violet-50 text-violet-600 hover:bg-violet-100 dark:bg-violet-500/10 dark:text-violet-300',
      purple: 'bg-purple-50 text-purple-600 hover:bg-purple-100 dark:bg-purple-500/10 dark:text-purple-400',
      yellow: 'bg-gray-50 text-gray-500 hover:bg-yellow-50 hover:text-yellow-500 dark:bg-white/[0.04]',
      red: 'bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-500/10 dark:text-red-400',
    }
    return `${textButtonClass} ${textTones[tone]}`
  }

  return (
    <div
      data-task-action-row={presentation}
      className={`flex w-full flex-shrink-0 flex-wrap items-center ${rowClass} ${className}`}
      onClick={(event) => event.stopPropagation()}
    >
      {shouldShowTaskRetry(task, presentation, alwaysShowRetry) && (
        <button type="button" className={buttonClass('blue')} title="重试任务" aria-label="重试任务" onClick={actions.retry}>
          <RotateCcwIcon className="h-4 w-4" aria-hidden="true" />
          {showLabels && <span>重试</span>}
        </button>
      )}
      <button
        type="button"
        className={buttonClass('yellow')}
        title={task.isFavorite ? '取消收藏' : '收藏记录'}
        aria-label={task.isFavorite ? '取消收藏' : '收藏记录'}
        onClick={actions.toggleFavorite}
      >
        <StarIcon className="h-4 w-4" fill={task.isFavorite ? 'currentColor' : 'none'} aria-hidden="true" />
        {showLabels && <span>{task.isFavorite ? '取消收藏' : '收藏'}</span>}
      </button>
      <button type="button" className={buttonClass('blue')} title={reuseLabel} aria-label={reuseLabel} onClick={actions.reuse}>
        <ReuseIcon className="h-4 w-4" aria-hidden="true" />
        {showLabels && <span>{reuseLabel}</span>}
      </button>
      <button type="button" className={buttonClass('green')} title="编辑输出" aria-label="编辑输出" disabled={!hasOutput} onClick={actions.editOutputs}>
        <EditIcon className="h-4 w-4" aria-hidden="true" />
        {showLabels && <span>编辑输出</span>}
      </button>
      <button type="button" className={buttonClass('violet')} title="在 OpenShop 中高级编辑" aria-label="在 OpenShop 中高级编辑" disabled={!hasOutput} onClick={actions.advancedEdit}>
        <ExternalLinkIcon className="h-4 w-4" aria-hidden="true" />
        {showLabels && <span>高级编辑</span>}
      </button>
      <button type="button" className={buttonClass('purple')} title="遮罩编辑" aria-label="遮罩编辑" disabled={!hasOutput} onClick={actions.maskEdit}>
        <MaskEditIcon className="h-4 w-4" aria-hidden="true" />
        {showLabels && <span>遮罩编辑</span>}
      </button>
      <button type="button" className={buttonClass('red')} title="删除记录" aria-label="删除记录" onClick={actions.deleteTask}>
        <TrashIcon className="h-4 w-4" aria-hidden="true" />
        {showLabels && <span>删除记录</span>}
      </button>
    </div>
  )
}

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'

const storeMocks = vi.hoisted(() => ({
  editOutputs: vi.fn(),
  removeTask: vi.fn(() => Promise.resolve()),
  retryTask: vi.fn(),
  reuseConfig: vi.fn(),
  updateTaskInStore: vi.fn(),
}))

const unifiedExecutorMocks = vi.hoisted(() => ({
  cancelUnifiedAgentTask: vi.fn(),
  retryUnifiedAgentTask: vi.fn(),
}))

vi.mock('../store', () => ({
  useStore: <T,>(selector: (state: {
    setMaskEditorImageId: () => void
    setConfirmDialog: () => void
    showToast: () => void
  }) => T) => selector({
    setMaskEditorImageId: vi.fn(),
    setConfirmDialog: vi.fn(),
    showToast: vi.fn(),
  }),
  ...storeMocks,
}))

vi.mock('../lib/agentExecutor', () => unifiedExecutorMocks)

import TaskActionRow, {
  createTaskActionCallbacks,
  shouldShowTaskRetry,
  shouldShowUnifiedAgentCancel,
} from './TaskActionRow'

const task: TaskRecord = {
  id: 'task-a',
  prompt: '生成一张产品海报',
  params: { ...DEFAULT_PARAMS },
  inputImageIds: [],
  outputImages: ['output-a'],
  status: 'done',
  error: null,
  createdAt: 1,
  finishedAt: 2,
  elapsed: 1,
  isFavorite: false,
}

describe('TaskActionRow', () => {
  it('在 Agent presentation 中直显完整操作并允许换行', () => {
    const markup = renderToStaticMarkup(<TaskActionRow task={task} presentation="agent" />)

    expect(markup).toContain('data-task-action-row="agent"')
    expect(markup).toContain('flex-wrap')
    expect(markup).toContain('复用')
    expect(markup).toContain('编辑输出')
    expect(markup).toContain('下载原图')
    expect(markup).toContain('高级编辑')
    expect(markup).toContain('遮罩编辑')
    expect(markup).toContain('收藏')
    expect(markup).toContain('重试')
    expect(markup).toContain('删除记录')
  })

  it('没有输出时禁用所有依赖输出的编辑动作', () => {
    const markup = renderToStaticMarkup(
      <TaskActionRow task={{ ...task, outputImages: [] }} presentation="workspace" />,
    )

    expect(markup).toMatch(/title="编辑输出"[^>]*disabled=""/)
    expect(markup).toMatch(/title="下载原图"[^>]*disabled=""/)
    expect(markup).toMatch(/title="在 OpenShop 中高级编辑"[^>]*disabled=""/)
    expect(markup).toMatch(/title="遮罩编辑"[^>]*disabled=""/)
  })

  it('收藏标题与状态随任务状态切换', () => {
    expect(renderToStaticMarkup(<TaskActionRow task={task} presentation="compact" />)).toContain('title="收藏记录"')
    expect(renderToStaticMarkup(
      <TaskActionRow task={{ ...task, isFavorite: true }} presentation="compact" />,
    )).toContain('title="取消收藏"')
  })

  it('仅为适用任务展示普通重试', () => {
    expect(shouldShowTaskRetry(task, 'agent')).toBe(true)
    expect(shouldShowTaskRetry({ ...task, origin: 'restricted-agent' }, 'agent')).toBe(false)
    expect(shouldShowTaskRetry({ ...task, origin: 'openshop' }, 'agent')).toBe(false)
    expect(shouldShowTaskRetry({ ...task, status: 'error', customRecoverable: true }, 'compact')).toBe(false)
    expect(shouldShowTaskRetry(task, 'compact', false)).toBe(false)
    expect(shouldShowTaskRetry({ ...task, status: 'error' }, 'compact', false)).toBe(true)
    expect(shouldShowTaskRetry(task, 'compact', true)).toBe(true)
  })

  it('统一 Gateway 回合在运行时提供取消执行，并在失败后使用统一重试', () => {
    const gatewayTask: TaskRecord = {
      ...task,
      id: 'gateway-task',
      origin: 'agent',
      status: 'running',
      finishedAt: null,
      elapsed: null,
      agentRoute: 'tool_pipeline',
      agentExecutionId: 'execution-1',
      agentPlanSnapshot: { schemaVersion: 3 } as TaskRecord['agentPlanSnapshot'],
    }
    const runningMarkup = renderToStaticMarkup(<TaskActionRow task={gatewayTask} presentation="agent" />)
    const runningActions = createTaskActionCallbacks({
      task: gatewayTask,
      setMaskEditorImageId: vi.fn(),
      setConfirmDialog: vi.fn(),
      focusInputEditor: vi.fn(),
    })

    expect(shouldShowUnifiedAgentCancel(gatewayTask)).toBe(true)
    expect(shouldShowTaskRetry(gatewayTask, 'agent')).toBe(false)
    expect(runningMarkup).toContain('aria-label="取消执行"')
    runningActions.cancel()
    expect(unifiedExecutorMocks.cancelUnifiedAgentTask).toHaveBeenCalledWith(gatewayTask)

    const failedTask: TaskRecord = { ...gatewayTask, status: 'error', error: '执行失败', finishedAt: 3, elapsed: 2 }
    const failedActions = createTaskActionCallbacks({
      task: failedTask,
      setMaskEditorImageId: vi.fn(),
      setConfirmDialog: vi.fn(),
      focusInputEditor: vi.fn(),
    })

    expect(shouldShowUnifiedAgentCancel(failedTask)).toBe(false)
    expect(shouldShowTaskRetry(failedTask, 'agent')).toBe(true)
    failedActions.retry()
    expect(unifiedExecutorMocks.retryUnifiedAgentTask).toHaveBeenCalledWith(failedTask)
  })

  it('复用和编辑完成后恢复输入焦点，modal 场景同时关闭', async () => {
    const focusInputEditor = vi.fn()
    const onRequestClose = vi.fn()
    const onReuse = vi.fn(() => Promise.resolve())
    const onEditOutputs = vi.fn(() => Promise.resolve())
    const actions = createTaskActionCallbacks({
      task,
      presentation: 'modal',
      onReuse,
      onEditOutputs,
      onRequestClose,
      setMaskEditorImageId: vi.fn(),
      setConfirmDialog: vi.fn(),
      focusInputEditor,
    })

    actions.reuse()
    actions.editOutputs()
    await Promise.resolve()

    expect(onReuse).toHaveBeenCalledOnce()
    expect(onEditOutputs).toHaveBeenCalledOnce()
    expect(onRequestClose).toHaveBeenCalledTimes(2)
    expect(focusInputEditor).toHaveBeenCalledTimes(2)
  })

  it('删除先关闭 modal 并打开确认框，仅在确认后删除', async () => {
    const onRequestClose = vi.fn()
    const setConfirmDialog = vi.fn()
    const onDeleteCommitted = vi.fn()
    const actions = createTaskActionCallbacks({
      task,
      presentation: 'modal',
      onRequestClose,
      onDeleteCommitted,
      setMaskEditorImageId: vi.fn(),
      setConfirmDialog,
      focusInputEditor: vi.fn(),
    })

    actions.deleteTask()

    expect(onRequestClose).toHaveBeenCalledOnce()
    expect(storeMocks.removeTask).not.toHaveBeenCalled()
    expect(setConfirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '删除记录' }))

    setConfirmDialog.mock.calls[0][0].action()
    await Promise.resolve()

    expect(storeMocks.removeTask).toHaveBeenCalledWith(task)
    expect(onDeleteCommitted).toHaveBeenCalledOnce()
  })

  it('workspace 动作不会触发 modal 关闭', () => {
    const onRequestClose = vi.fn()
    const onAdvancedEdit = vi.fn()
    const setMaskEditorImageId = vi.fn()
    const actions = createTaskActionCallbacks({
      task,
      presentation: 'workspace',
      onRequestClose,
      onAdvancedEdit,
      setMaskEditorImageId,
      setConfirmDialog: vi.fn(),
      focusInputEditor: vi.fn(),
    })

    actions.advancedEdit()
    actions.maskEdit()

    expect(onAdvancedEdit).toHaveBeenCalledWith('output-a', 'task-a')
    expect(setMaskEditorImageId).toHaveBeenCalledWith('output-a')
    expect(onRequestClose).not.toHaveBeenCalled()
  })

  it('下载动作只传递当前输出图片 ID，且不会关闭 modal', () => {
    const onRequestClose = vi.fn()
    const onDownload = vi.fn()
    const actions = createTaskActionCallbacks({
      task,
      presentation: 'modal',
      onDownload,
      onRequestClose,
      setMaskEditorImageId: vi.fn(),
      setConfirmDialog: vi.fn(),
      focusInputEditor: vi.fn(),
    })

    actions.download()

    expect(onDownload).toHaveBeenCalledWith('output-a')
    expect(onRequestClose).not.toHaveBeenCalled()
  })
})

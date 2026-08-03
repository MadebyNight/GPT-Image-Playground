import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'

vi.mock('../store', () => ({
  useStore: <T,>(selector: (state: { toggleTaskSelection: () => void; settings: { alwaysShowRetryButton: boolean } }) => T) =>
    selector({
      toggleTaskSelection: vi.fn(),
      settings: { alwaysShowRetryButton: true },
    }),
  ensureImageThumbnailCached: vi.fn(async () => undefined),
  subscribeImageThumbnail: vi.fn(() => vi.fn()),
  updateTaskInStore: vi.fn(),
  retryTask: vi.fn(),
}))

import TaskCard from './TaskCard'

const task: TaskRecord = {
  id: 'task-a',
  prompt: '生成一张产品海报',
  params: { ...DEFAULT_PARAMS, size: '1024x1024' },
  inputImageIds: [],
  outputImages: ['output-a'],
  status: 'done',
  error: null,
  createdAt: 1,
  finishedAt: 2,
  elapsed: 1,
  isFavorite: false,
}

describe('TaskCard', () => {
  it('keeps task actions available in compact variant', () => {
    const markup = renderToStaticMarkup(
      <TaskCard
        task={task}
        variant="compact"
        selectionEnabled={false}
        onClick={vi.fn()}
        onReuse={vi.fn()}
        onEditOutputs={vi.fn()}
        onAdvancedEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(markup).toContain('生成一张产品海报')
    expect(markup).toContain('title="重试任务"')
    expect(markup).toContain('title="收藏记录"')
    expect(markup).toContain('title="复用输入与参数"')
    expect(markup).toContain('title="编辑输出"')
    expect(markup).toContain('title="在 OpenShop 中高级编辑"')
    expect(markup).toContain('高级编辑')
    expect(markup).toContain('title="删除记录"')
  })

  it('does not expose ordinary retry for restricted Agent tasks', () => {
    const markup = renderToStaticMarkup(
      <TaskCard
        task={{ ...task, origin: 'restricted-agent', agentExecutionId: 'execution-1' }}
        variant="compact"
        selectionEnabled={false}
        onClick={vi.fn()}
        onReuse={vi.fn()}
        onEditOutputs={vi.fn()}
        onAdvancedEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(markup).not.toContain('title="重试任务"')
  })

  it('does not expose API retry for an OpenShop edit history', () => {
    const markup = renderToStaticMarkup(
      <TaskCard
        task={{ ...task, origin: 'openshop', apiProvider: 'openshop', sourceTaskId: 'task-source' }}
        variant="compact"
        selectionEnabled={false}
        onClick={vi.fn()}
        onReuse={vi.fn()}
        onEditOutputs={vi.fn()}
        onAdvancedEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(markup).not.toContain('title="重试任务"')
    expect(markup).toContain('高级编辑')
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_INPUT_PLACEHOLDER,
  getInputBarPresentationClass,
  getInputBarSubmitRoute,
  startAgentSubmission,
} from './InputBar'

describe('InputBar submit routing', () => {
  it('routes the only Agent input to the unified Agent executor', () => {
    expect(getInputBarSubmitRoute('default')).toBe('gallery')
    expect(getInputBarSubmitRoute('agent')).toBe('agent')
  })

  it('uses the single Agent prompt without exposing Chat or Tool terminology', () => {
    expect(AGENT_INPUT_PLACEHOLDER).toBe('描述想生成或编辑的图片；可添加参考图，也可指定尺寸、裁剪或旋转。')
    expect(AGENT_INPUT_PLACEHOLDER).not.toMatch(/Chat|Tool/)
  })

  it('keeps Gallery fixed while Agent can render inside its conversation column', () => {
    expect(getInputBarPresentationClass('fixed')).toContain('fixed')
    expect(getInputBarPresentationClass('fixed')).toContain('bottom-4')
    expect(getInputBarPresentationClass('embedded')).not.toContain('fixed')
    expect(getInputBarPresentationClass('embedded')).not.toContain('bottom-4')
    expect(getInputBarPresentationClass('embedded')).toContain('relative')
  })

  it('uses a synchronous lock to reject a second Agent submission before the first resolves', async () => {
    const lock = { current: false }
    let resolveFirstSubmission: (value: string) => void = () => undefined
    const submit = vi.fn(() => new Promise<string>((resolve) => {
      resolveFirstSubmission = resolve
    }))

    const firstSubmission = startAgentSubmission(lock, submit)
    const duplicateSubmission = startAgentSubmission(lock, submit)
    await Promise.resolve()

    expect(firstSubmission).not.toBeNull()
    expect(duplicateSubmission).toBeNull()
    expect(submit).toHaveBeenCalledOnce()
    if (!firstSubmission) throw new Error('首次 Agent 提交应成功获得执行 Promise')

    resolveFirstSubmission('task-1')
    await expect(firstSubmission).resolves.toBe('task-1')
    expect(lock.current).toBe(false)
    await expect(startAgentSubmission(lock, () => Promise.resolve('task-2'))).resolves.toBe('task-2')
  })
})

import { describe, expect, it } from 'vitest'
import { getInputBarPresentationClass, getInputBarSubmitRoute } from './InputBar'

describe('InputBar submit routing', () => {
  it('routes explicit Chat and Tool modes without reading capability as current mode', () => {
    expect(getInputBarSubmitRoute('default', 'tool')).toBe('gallery')
    expect(getInputBarSubmitRoute('agent', 'chat')).toBe('chat')
    expect(getInputBarSubmitRoute('agent', 'tool')).toBe('tool')
  })

  it('keeps Gallery fixed while Agent can render inside its conversation column', () => {
    expect(getInputBarPresentationClass('fixed')).toContain('fixed')
    expect(getInputBarPresentationClass('fixed')).toContain('bottom-4')
    expect(getInputBarPresentationClass('embedded')).not.toContain('fixed')
    expect(getInputBarPresentationClass('embedded')).not.toContain('bottom-4')
    expect(getInputBarPresentationClass('embedded')).toContain('relative')
  })
})

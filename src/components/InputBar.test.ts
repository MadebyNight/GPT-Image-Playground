import { describe, expect, it } from 'vitest'
import { getInputBarSubmitRoute } from './InputBar'

describe('InputBar submit routing', () => {
  it('routes explicit Chat and Tool modes without reading capability as current mode', () => {
    expect(getInputBarSubmitRoute('default', 'tool')).toBe('gallery')
    expect(getInputBarSubmitRoute('agent', 'chat')).toBe('chat')
    expect(getInputBarSubmitRoute('agent', 'tool')).toBe('tool')
  })
})

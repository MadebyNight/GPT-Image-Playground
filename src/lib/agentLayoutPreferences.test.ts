import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_LAYOUT_PREFERENCE_KEY,
  DEFAULT_AGENT_LAYOUT_PREFERENCES,
  getAgentLayoutPreferences,
  setAgentLayoutPreferences,
} from './agentLayoutPreferences'

function createStorage(initialValue: string | null = null) {
  const storage = {
    value: initialValue,
    getItem: vi.fn(() => storage.value),
    setItem: vi.fn((_key: string, value: string) => {
      storage.value = value
    }),
  }

  return storage
}

describe('Agent layout preferences', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to expanded desktop history and collapsed desktop templates', () => {
    expect(getAgentLayoutPreferences(null)).toEqual({
      historyExpanded: true,
      templateExpanded: false,
    })
    expect(DEFAULT_AGENT_LAYOUT_PREFERENCES).toEqual({
      historyExpanded: true,
      templateExpanded: false,
    })
  })

  it('saves and restores valid desktop preferences', () => {
    const storage = createStorage()

    setAgentLayoutPreferences({ historyExpanded: false, templateExpanded: true }, storage)

    expect(storage.setItem).toHaveBeenCalledWith(
      AGENT_LAYOUT_PREFERENCE_KEY,
      JSON.stringify({ historyExpanded: false, templateExpanded: true }),
    )
    expect(getAgentLayoutPreferences(storage)).toEqual({
      historyExpanded: false,
      templateExpanded: true,
    })
  })

  it.each([
    ['missing value', null],
    ['invalid JSON', '{invalid'],
    ['non-object JSON', '[]'],
    ['missing field', JSON.stringify({ historyExpanded: false })],
    ['invalid history field', JSON.stringify({ historyExpanded: 'false', templateExpanded: true })],
    ['invalid template field', JSON.stringify({ historyExpanded: false, templateExpanded: 1 })],
  ])('falls back to defaults for %s', (_label, storedValue) => {
    expect(getAgentLayoutPreferences(createStorage(storedValue))).toEqual(DEFAULT_AGENT_LAYOUT_PREFERENCES)
  })

  it('silently falls back when storage access throws', () => {
    const throwingStorage = {
      getItem: vi.fn(() => {
        throw new DOMException('blocked', 'SecurityError')
      }),
      setItem: vi.fn(() => {
        throw new DOMException('blocked', 'SecurityError')
      }),
    }

    expect(getAgentLayoutPreferences(throwingStorage)).toEqual(DEFAULT_AGENT_LAYOUT_PREFERENCES)
    expect(() => setAgentLayoutPreferences(DEFAULT_AGENT_LAYOUT_PREFERENCES, throwingStorage)).not.toThrow()
  })

  it('silently falls back when the browser localStorage getter throws', () => {
    const restrictedWindow = {}
    Object.defineProperty(restrictedWindow, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError')
      },
    })
    vi.stubGlobal('window', restrictedWindow)

    expect(getAgentLayoutPreferences()).toEqual(DEFAULT_AGENT_LAYOUT_PREFERENCES)
    expect(() => setAgentLayoutPreferences(DEFAULT_AGENT_LAYOUT_PREFERENCES)).not.toThrow()
  })

  it('persists desktop fields only and never mobile drawer state', () => {
    const storage = createStorage()
    const preferencesWithTransientState = {
      historyExpanded: false,
      templateExpanded: true,
      mobileDrawer: 'history',
    }

    setAgentLayoutPreferences(preferencesWithTransientState, storage)

    expect(JSON.parse(storage.value ?? '{}')).toEqual({
      historyExpanded: false,
      templateExpanded: true,
    })
  })
})

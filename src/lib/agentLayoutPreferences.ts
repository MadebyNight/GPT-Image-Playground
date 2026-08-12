export const AGENT_LAYOUT_PREFERENCE_KEY = 'gpt-image-playground:agent-layout-preferences'

export interface AgentLayoutPreferences {
  historyExpanded: boolean
  templateExpanded: boolean
}

export const DEFAULT_AGENT_LAYOUT_PREFERENCES: Readonly<AgentLayoutPreferences> = Object.freeze({
  historyExpanded: true,
  templateExpanded: false,
})

type AgentLayoutPreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

function getDefaultStorage(): AgentLayoutPreferenceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function createDefaultPreferences(): AgentLayoutPreferences {
  return { ...DEFAULT_AGENT_LAYOUT_PREFERENCES }
}

function parseAgentLayoutPreferences(value: string | null): AgentLayoutPreferences | null {
  if (value === null) return null

  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

    const preferences = parsed as Record<string, unknown>
    if (typeof preferences.historyExpanded !== 'boolean' || typeof preferences.templateExpanded !== 'boolean') {
      return null
    }

    return {
      historyExpanded: preferences.historyExpanded,
      templateExpanded: preferences.templateExpanded,
    }
  } catch {
    return null
  }
}

export function getAgentLayoutPreferences(storage?: AgentLayoutPreferenceStorage | null): AgentLayoutPreferences {
  try {
    const targetStorage = storage === undefined ? getDefaultStorage() : storage
    if (!targetStorage) return createDefaultPreferences()

    return parseAgentLayoutPreferences(targetStorage.getItem(AGENT_LAYOUT_PREFERENCE_KEY)) ?? createDefaultPreferences()
  } catch {
    return createDefaultPreferences()
  }
}

export function setAgentLayoutPreferences(
  preferences: AgentLayoutPreferences,
  storage?: AgentLayoutPreferenceStorage | null,
): void {
  try {
    const targetStorage = storage === undefined ? getDefaultStorage() : storage
    if (!targetStorage) return

    targetStorage.setItem(AGENT_LAYOUT_PREFERENCE_KEY, JSON.stringify({
      historyExpanded: preferences.historyExpanded,
      templateExpanded: preferences.templateExpanded,
    }))
  } catch {
    // localStorage 被禁用或配额不足时，只保留当前会话内的布局状态。
  }
}

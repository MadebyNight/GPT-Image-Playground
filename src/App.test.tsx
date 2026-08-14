import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const runtimeConfigMock = vi.hoisted(() => ({ responsesUsable: true, tool: false, agentOnly: false }))

vi.mock('./store', () => {
  const state = { setSettings: vi.fn(), setComposerScope: vi.fn(), settings: { apiMode: 'responses' }, tasks: [] }
  return {
    initStore: vi.fn(),
    ensureImageCached: vi.fn(),
    saveOpenShopEdit: vi.fn(),
    useStore: (selector: (value: typeof state) => unknown) => selector(state),
  }
})

vi.mock('./lib/urlSettings', () => ({
  buildSettingsFromUrlParams: vi.fn(),
  clearUrlSettingParams: vi.fn(),
  hasUrlSettingParams: vi.fn(() => false),
}))
vi.mock('./hooks/useDockerApiUrlMigrationNotice', () => ({
  useDockerApiUrlMigrationNotice: vi.fn(),
}))
vi.mock('./restrictedAgentStore', () => ({
  useRestrictedAgentStore: <T,>(selector: (value: { recover: () => Promise<void> }) => T) => selector({ recover: vi.fn(async () => undefined) }),
}))
vi.mock('./lib/serverApiConfig', () => ({
  getAgentCapabilities: () => ({
    agentUsable: runtimeConfigMock.responsesUsable,
    responsesUsable: runtimeConfigMock.responsesUsable,
    toolPipelineUsable: runtimeConfigMock.tool,
    chatAllowed: runtimeConfigMock.responsesUsable,
    chatConfigured: runtimeConfigMock.responsesUsable,
    chatUsable: runtimeConfigMock.responsesUsable,
    tool: runtimeConfigMock.tool,
    openShopTool: false,
    defaultMode: runtimeConfigMock.responsesUsable ? 'chat' : null,
    modeSwitching: false,
  }),
  getAgentModePreference: () => null,
  getRuntimeConfigState: () => ({ status: 'ready', config: { version: 1, serverApi: { enabled: false } } }),
  resolveAgentMode: (capabilities: { defaultMode: 'chat' | 'tool' | null }, preferred: 'chat' | 'tool' | null) => preferred ?? capabilities.defaultMode,
  setAgentModePreference: vi.fn(),
  isRestrictedAgentEnabled: () => runtimeConfigMock.tool,
  isRestrictedAgentOnly: () => runtimeConfigMock.tool && runtimeConfigMock.agentOnly,
}))

vi.mock('./components/Header', () => ({ default: () => <div data-component="header" /> }))
vi.mock('./components/TemplateGallery', () => ({ default: () => <div data-component="template-gallery" /> }))
vi.mock('./components/SearchBar', () => ({ default: () => <div data-component="search-bar" /> }))
vi.mock('./components/TaskGrid', () => ({ default: () => <div data-component="task-grid" /> }))
vi.mock('./components/AgentWorkspace', () => ({
  default: ({ activeTaskId, composer }: { activeTaskId: string | null; composer?: React.ReactNode }) => (
    <div data-component="agent-workspace" data-active-task={activeTaskId ?? ''}>{composer}</div>
  ),
}))
vi.mock('./components/InputBar', () => ({
  default: ({ presentation = 'fixed', ...props }: { presentation?: string }) => (
    <div data-component="input-bar" data-has-agent-mode={String('agentMode' in props)} data-presentation={presentation} />
  ),
}))
vi.mock('./components/DetailModal', () => ({ default: () => <div data-component="detail-modal" /> }))
vi.mock('./components/Lightbox', () => ({ default: () => <div data-component="lightbox" /> }))
vi.mock('./components/SettingsModal', () => ({ default: () => <div data-component="settings-modal" /> }))
vi.mock('./components/ConfirmDialog', () => ({ default: () => <div data-component="confirm-dialog" /> }))
vi.mock('./components/Toast', () => ({ default: () => <div data-component="toast" /> }))
vi.mock('./components/MaskEditorModal', () => ({ default: () => <div data-component="mask-editor" /> }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => <div data-component="image-context-menu" /> }))
vi.mock('./components/OpenShopWorkspace', () => ({
  default: ({ imageId, taskId }: { imageId: string; taskId: string | null }) => (
    <div data-component="openshop-workspace" data-image-id={imageId} data-task-id={taskId ?? ''} />
  ),
}))

import App, { getWorkspaceComposerScope } from './App'

describe('App workspace entry', () => {
  beforeEach(() => {
    runtimeConfigMock.responsesUsable = true
    runtimeConfigMock.tool = false
    runtimeConfigMock.agentOnly = false
  })
  it('keeps the legacy gallery and Agent entries when restricted Agent is disabled', () => {
    runtimeConfigMock.responsesUsable = true
    runtimeConfigMock.tool = false
    runtimeConfigMock.agentOnly = false
    const markup = renderToStaticMarkup(<App />)
    const templateIndex = markup.indexOf('data-component="template-gallery"')
    const searchIndex = markup.indexOf('data-component="search-bar"')
    const taskGridIndex = markup.indexOf('data-component="task-grid"')

    expect(templateIndex).toBe(-1)
    expect(searchIndex).toBeGreaterThan(-1)
    expect(taskGridIndex).toBeGreaterThan(searchIndex)
    expect(markup).toContain('data-component="input-bar"')
    expect(markup).toContain('data-presentation="fixed"')
    expect(markup).toContain('role="tablist"')
    expect(markup).toContain('画廊')
    expect(markup).toContain('Agent')
    expect(markup).toContain('data-component="agent-workspace"')
    expect(markup).toContain('data-agent-workspace-mounted')
    expect(markup).not.toContain('data-has-agent-mode="true"')
  })

  it('uses the unified Agent composer scope without a mode preference', () => {
    expect(getWorkspaceComposerScope('gallery')).toBe('gallery')
    expect(getWorkspaceComposerScope('agent')).toBe('agent')
  })

  it('keeps both workspace entries when restricted Agent is enabled but not agent-only', () => {
    runtimeConfigMock.responsesUsable = true
    runtimeConfigMock.tool = true
    runtimeConfigMock.agentOnly = false

    const markup = renderToStaticMarkup(<App />)

    expect(markup).toContain('role="tablist"')
    expect(markup).toContain('画廊')
    expect(markup).toContain('Agent')
    expect(markup).toContain('data-component="task-grid"')
    expect(markup).toContain('data-component="agent-workspace"')
    expect(markup).toContain('data-agent-workspace-mounted')
  })

  it('opens the Agent workspace directly in agent-only mode', () => {
    runtimeConfigMock.responsesUsable = true
    runtimeConfigMock.tool = true
    runtimeConfigMock.agentOnly = true

    const markup = renderToStaticMarkup(<App />)

    expect(markup).toContain('data-component="agent-workspace"')
    expect(markup).toContain('data-presentation="embedded"')
    expect(markup).not.toContain('data-presentation="fixed"')
    expect(markup).not.toContain('data-component="task-grid"')
    expect(markup).not.toContain('role="tablist"')
  })

  it('disables the Agent entry when neither Chat nor Tool is usable', () => {
    runtimeConfigMock.responsesUsable = false
    runtimeConfigMock.tool = false
    runtimeConfigMock.agentOnly = false

    const markup = renderToStaticMarkup(<App />)

    expect(markup).toContain('Agent 尚不可用')
    expect(markup).toContain('disabled=""')
  })

  it('renders the full-page OpenShop workspace for an advanced-edit hash route', () => {
    vi.stubGlobal('window', {
      location: { hash: '#/openshop/image%2F1?task=task-1' },
    })

    const markup = renderToStaticMarkup(<App />)

    expect(markup).toContain('data-component="openshop-workspace"')
    expect(markup).toContain('data-image-id="image/1"')
    expect(markup).toContain('data-task-id="task-1"')
    expect(markup).not.toContain('data-component="task-grid"')
    vi.unstubAllGlobals()
  })
})

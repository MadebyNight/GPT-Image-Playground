// 此项目的浏览器 tsconfig 不引入 Node 类型；Vitest 运行时仍提供这些内置模块。
// @ts-expect-error node:fs 仅用于验证发布到 public 的 OpenShop 外壳
import { readFileSync } from 'node:fs'
// @ts-expect-error node:crypto 仅用于验证 CSP inline-script hash
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const HOST_VERSION = '0.24.0-host.2'
const PREVIOUS_HOST_VERSION = '0.24.0-host.1'
const V024_CORE_RUNTIME_ASSETS = [
  'https://cdn.jsdelivr.net/npm/fabric@7.4.0/dist/index.min.js',
  'https://cdn.jsdelivr.net/npm/ag-psd@22.0.2/dist/bundle.js',
  'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js',
]

const editorHtml = readFileSync('public/openshop/index.html', 'utf8')
const manifest = JSON.parse(readFileSync('public/openshop/manifest.webmanifest', 'utf8')) as {
  name: string
  description: string
  version?: string
}
const serviceWorker = readFileSync('public/openshop/sw.js', 'utf8')

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getChineseLocaleSource() {
  const source = editorHtml.match(/_locales:\s*\{\s*en:\s*\{\},\s*zh:\s*\{([\s\S]*?)\n\s*\}\s*\},\s*\n?\s*_lang:/)?.[1] ?? ''

  expect(source).not.toBe('')
  return source
}

function expectChineseTranslation(locale: string, key: string, translation: string) {
  const entry = new RegExp(`['"]${escapeRegExp(key)}['"]\\s*:\\s*['"]${escapeRegExp(translation)}['"]`)
  expect(locale).toMatch(entry)
}

function expectLocalizedAttributeMarkup(dataAttribute: string, key: string, attribute: string, translation: string) {
  const keyAttribute = `${escapeRegExp(dataAttribute)}="${escapeRegExp(key)}"`
  const translatedAttribute = `${escapeRegExp(attribute)}="${escapeRegExp(translation)}"`
  const tag = new RegExp(`<[^>]*(?:${keyAttribute}[^>]*${translatedAttribute}|${translatedAttribute}[^>]*${keyAttribute})[^>]*>`)

  expect(editorHtml).toMatch(tag)
}

function getEmbedBridgeSource() {
  const start = editorHtml.indexOf('// ====================== HOST EMBED BRIDGE ======================')
  const end = editorHtml.indexOf("\ndocument.addEventListener('click'", start)

  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return editorHtml.slice(start, end)
}

function getWorkerStringArray(name: string) {
  const source = serviceWorker.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))?.[1] ?? ''
  return [...source.matchAll(/"([^"]+)"/g)].map(([, value]) => value)
}

function getObjectMethodSource(name: string) {
  const start = editorHtml.indexOf(`    ${name}(`)
  const end = editorHtml.indexOf('\n    },', start)

  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return editorHtml.slice(start, end)
}

function expectLocalizedRuntimeMessage(key: string) {
  const invocation = new RegExp(`this\\._(?:t|format)\\(\\s*['"]${escapeRegExp(key)}['"]`)
  expect(editorHtml).toMatch(invocation)
}

function expectLocalizedMethodMessage(source: string, key: string) {
  const invocation = new RegExp(`this\\._(?:t|format)\\(\\s*['"]${escapeRegExp(key)}['"]`)
  expect(source).toMatch(invocation)
}

describe('OpenShop v0.24-host.2 发布产物契约', () => {
  it('uses the v0.24 host baseline and defaults to Simplified Chinese', () => {
    expect(editorHtml).toContain('<html lang="zh-CN">')
    expect(editorHtml).toContain(`<title>OpenShop v${HOST_VERSION} — 在线图像编辑器</title>`)
    expect(editorHtml).toContain("_lang: 'zh'")
    expect(editorHtml).toContain("this.setLocale(localStorage.getItem('os_lang') === 'en' ? 'en' : 'zh')")
    expect(editorHtml).toContain(`appVersion: '${HOST_VERSION}'`)
    expect(manifest.version).toBe(HOST_VERSION)
    expect(manifest.name).toBe('OpenShop 图像编辑器')
    expect(manifest.description).toContain('私密的浏览器端图像编辑器')
  })

  it('keeps the first screen and editor chrome visibly translated before runtime hydration', () => {
    const locale = getChineseLocaleSource()
    const firstScreen = [
      ['Local creative studio', '本地创作工作室'],
      ['Edit boldly.', '尽情编辑。'],
      ['New Canvas', '新建画布'],
      ['Open Image', '打开图像'],
      ['Open PSD', '打开 PSD'],
      ['Enter Studio', '进入工作区'],
      ['Start from Template', '从模板开始'],
      ['HISTORY', '历史记录'],
      ['LAYERS', '图层'],
    ]

    for (const [key, translation] of firstScreen) {
      expectChineseTranslation(locale, key, translation)
      const markup = new RegExp(`data-i18n="${escapeRegExp(key)}"[^>]*>\\s*${escapeRegExp(translation)}`)
      expect(editorHtml).toMatch(markup)
    }
  })

  it('keeps Canvas accessibility baseline and live status summaries in Chinese', () => {
    const locale = getChineseLocaleSource()
    const baseline = [
      ['Canvas state', '画布状态'],
      ['OpenShop canvas ready.', 'OpenShop 画布已就绪。'],
      ['Tool: Select', '工具：选择'],
      ['Active layer: none', '当前图层：无'],
      ['Selection: none', '选区：无'],
      ['Objects: 0', '对象：0'],
    ]

    for (const [key, translation] of baseline) {
      expectChineseTranslation(locale, key, translation)
      const markup = new RegExp(`data-i18n="${escapeRegExp(key)}"[^>]*>\\s*${escapeRegExp(translation)}`)
      expect(editorHtml).toMatch(markup)
    }
    expectLocalizedAttributeMarkup('data-i18n-aria-label', 'Canvas state', 'aria-label', '画布状态')

    const tree = getObjectMethodSource('_renderAccessibilityTree')
    const dynamicSummaries = [
      ['Tool: {tool}', '工具：{tool}'],
      ['Active layer: {layer}', '活动图层：{layer}'],
      ['Selection: {selection}', '选区：{selection}'],
      ['Objects: {objects}', '对象：{objects}'],
    ]
    for (const [key, translation] of dynamicSummaries) {
      expectChineseTranslation(locale, key, translation)
      expectLocalizedMethodMessage(tree, key)
    }
  })

  it('translates title, accessibility, placeholder, and role-description attributes', () => {
    const locale = getChineseLocaleSource()
    const attributes = [
      ['data-i18n-title', 'Fit canvas to view', 'title', '适配画布到视图'],
      ['data-i18n-aria-label', 'Image canvas', 'aria-label', '图像画布'],
      ['data-i18n-placeholder', 'Type a command... (Ctrl+K)', 'placeholder', '输入命令... (Ctrl+K)'],
      ['data-i18n-aria-roledescription', 'image editor canvas', 'aria-roledescription', '图像编辑画布'],
    ]

    for (const [dataAttribute, key, attribute, translation] of attributes) {
      expectChineseTranslation(locale, key, translation)
      expectLocalizedAttributeMarkup(dataAttribute, key, attribute, translation)
      const handler = new RegExp(`\\[\\s*['"]${escapeRegExp(dataAttribute)}['"]\\s*,\\s*['"]${escapeRegExp(attribute)}['"]\\s*\\]`)
      expect(editorHtml).toMatch(handler)
    }
    expect(editorHtml).toMatch(/_initI18n\(\s*root\s*=\s*document\s*\)/)
  })

  it('routes common modal and feedback messages through the Chinese locale', () => {
    const locale = getChineseLocaleSource()
    const dynamicMessages = [
      ['New Image', '新建图像'],
      ['Exported as {format}', '已导出为 {format}'],
      ['Created {width} × {height} canvas', '已创建 {width} × {height} 画布'],
      ['Layer locked', '图层已锁定'],
      ['Layer unlocked', '图层已解锁'],
    ]

    for (const [key, translation] of dynamicMessages) {
      expectChineseTranslation(locale, key, translation)
      expectLocalizedRuntimeMessage(key)
    }
  })

  it('normalizes every Toast through the runtime locale before rendering or announcing it', () => {
    const toast = getObjectMethodSource('toast')

    expect(toast).toMatch(/this\._t\(\s*String\(msg\)\s*\)/)
    expect(toast).not.toMatch(/\.textContent\s*=\s*msg\b/)
    expect(toast).not.toMatch(/_announceAccessibility\(msg\)/)
  })

  it('keeps exactly two CSP hashes synchronized with the inline editor scripts', () => {
    const policy = editorHtml.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? ''
    const scripts = [...editorHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, body]) => body)
    const cspHashes = [...policy.matchAll(/'sha256-([^']+)'/g)].map(([, hash]) => hash)

    expect(policy).toContain("frame-ancestors 'self'")
    expect(scripts).toHaveLength(2)
    expect(cspHashes).toHaveLength(2)
    expect(new Set(cspHashes)).toHaveLength(2)
    for (const script of scripts) {
      const hash = createHash('sha256').update(script, 'utf8').digest('base64')
      expect(cspHashes).toContain(hash)
    }
  })

  it('exposes only the same-origin parent bridge path for hello, Blob configure, and PNG export', () => {
    const bridge = getEmbedBridgeSource()

    expect(bridge).toContain('_embedProtocolVersion: 1')
    expect(bridge).toContain("_embedFormats: Object.freeze(['png'])")
    expect(bridge).toContain('event.source !== window.parent || event.origin !== location.origin')
    expect(bridge).toContain("if (!bound && data.type !== 'openshop:hello') return;")
    expect(bridge).toContain('}, host.origin);')
    expect(bridge).toContain('}, location.origin);')
    expect(bridge).not.toContain("}, '*');")

    expect(bridge).toContain("case 'openshop:hello':")
    expect(bridge).toContain("type:'openshop:ready'")
    expect(bridge).toContain("case 'openshop:configure':")
    expect(bridge).toContain('spec.blob instanceof Blob')
    expect(bridge).toContain('await this._applyEmbedDocument(data.document)')
    expect(bridge).toContain("type:'openshop:configured'")
    expect(bridge).toContain("case 'openshop:export':")
    expect(bridge).toContain("if (normalized !== 'png')")
    expect(bridge).toContain("blob.type !== 'image/png'")
    expect(bridge).toContain("type:'openshop:exported'")
    expect(bridge).toContain("format:'png'")
    expect(bridge).toContain('blob:captured.blob')
  })

  it('does not ship collaboration or WebRTC support', () => {
    for (const forbidden of [
      'Collaborative Session',
      'RTCPeerConnection',
      'RTCDataChannel',
      'webrtc',
      'iceServers',
      'openshop-collab',
      'collaboration',
    ]) {
      expect(editorHtml.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  it('publishes host.2 with only host.1 as the verified v0.24 rollback shell', () => {
    const revision = serviceWorker.match(/const SHELL_REVISION = '([^']+)'/)?.[1]
    const previousRevision = serviceWorker.match(/const PREVIOUS_SHELL_REVISION = '([^']+)'/)?.[1]
    const trustedRevisions = serviceWorker.match(/const TRUSTED_SHELL_REVISIONS = new Set\(\s*\[([\s\S]*?)\]\s*\);/)?.[1] ?? ''
    const requiredAssets = getWorkerStringArray('REQUIRED_ASSETS')

    expect(revision).toBe(HOST_VERSION)
    expect(previousRevision).toBe(PREVIOUS_HOST_VERSION)
    expect(trustedRevisions.replace(/\s/g, '')).toBe('SHELL_REVISION,PREVIOUS_SHELL_REVISION')
    expect(trustedRevisions).not.toContain('0.29')
    expect(serviceWorker).toContain('previousRevision: state.activeRevision')
    expect(serviceWorker).toMatch(/trimShellCaches\(\s*\[\s*state\.activeRevision\s*,\s*state\.previousRevision\s*,\s*SHELL_REVISION\s*\]\s*\)/)
    expect(requiredAssets).toEqual([
      './',
      './index.html',
      './manifest.webmanifest',
      './icon-192.png',
      './icon-512.png',
      ...V024_CORE_RUNTIME_ASSETS,
    ])
    for (const asset of V024_CORE_RUNTIME_ASSETS) {
      expect(editorHtml).toContain(`url:'${asset}'`)
    }
    expect(editorHtml).not.toContain('ag-psd@31.0.2')
  })
})

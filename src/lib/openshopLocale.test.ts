// 此项目的浏览器 tsconfig 不引入 Node 类型；Vitest 运行时仍提供这些内置模块。
// @ts-expect-error node:fs 仅用于验证发布到 public 的 OpenShop 外壳
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error node:crypto 仅用于验证 CSP inline-script hash
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const HOST_VERSION = '0.24.0-host.5'
const PREVIOUS_HOST_VERSION = '0.24.0-host.4'
const V024_CORE_RUNTIME_ASSETS = [
  './vendor/fabric-7.4.0.min.js',
]
const VENDORED_CORE_LIBRARIES = [
  {
    name: 'Fabric.js 7.4.0',
    file: 'fabric-7.4.0.min.js',
    bytes: 299_013,
    sha256: 'd4e908b3b3654db92c08ff0f31aa6a72ba1ddeeeb43a93bc41c833e51fe37f58',
    sri: 'sha256-1OkIs7NlTbksCP8PMapqcrod3u60OpO8Qcgz5R/jf1g=',
    upstream: 'https://cdn.jsdelivr.net/npm/fabric@7.4.0/dist/index.min.js',
  },
]
const VERIFIED_ON_DEMAND_LIBRARIES = [
  {
    key: 'psdDecoder',
    name: 'ag-psd 22.0.2',
    localFile: 'ag-psd-22.0.2.bundle.js',
    url: 'https://cdn.jsdelivr.net/npm/ag-psd@22.0.2/dist/bundle.js',
    integrity: 'sha384-kla4KJzEnshZnuWyJ8+AF8KEX0YZ2rpxTaQpDtDUmDdUv7jK94knsRx/lcRZ/HF4',
  },
  {
    key: 'pdfExporter',
    name: 'jsPDF 4.2.1',
    localFile: 'jspdf-4.2.1.umd.min.js',
    url: 'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js',
    integrity: 'sha384-qovJwSBbRDPP5cEjCp8S0UP66wrvnjaa60XMOGzTNanrThcrGfXfnZkvgY8N1KT3',
  },
]

const editorHtml = readFileSync('public/openshop/index.html', 'utf8')
const manifest = JSON.parse(readFileSync('public/openshop/manifest.webmanifest', 'utf8')) as {
  name: string
  description: string
  version?: string
}
const serviceWorker = readFileSync('public/openshop/sw.js', 'utf8')
const vendorNotice = readFileSync('public/openshop/vendor/THIRD_PARTY_NOTICES.md', 'utf8')
const vendorFiles = readdirSync('public/openshop/vendor').sort()

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

function compileObjectMethod(name: string) {
  const source = getObjectMethodSource(name).trim()
  const expression = `${source.replace(new RegExp(`^${escapeRegExp(name)}\\(`), 'function(')}\n}`
  return Function(`return (${expression})`)() as (...args: unknown[]) => unknown
}

function expectLocalizedRuntimeMessage(key: string) {
  const invocation = new RegExp(`this\\._(?:t|format)\\(\\s*['"]${escapeRegExp(key)}['"]`)
  expect(editorHtml).toMatch(invocation)
}

function expectLocalizedMethodMessage(source: string, key: string) {
  const invocation = new RegExp(`this\\._(?:t|format)\\(\\s*['"]${escapeRegExp(key)}['"]`)
  expect(source).toMatch(invocation)
}

describe('OpenShop v0.24-host.5 发布产物契约', () => {
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

  it('keeps static panels and re-rendered editor status in Chinese', () => {
    const locale = getChineseLocaleSource()
    const dynamicLabels = [
      ['Drag to create selection.', '拖动以创建选区。'],
      ['Cursor position: {x}, {y}', '坐标：{x}, {y}'],
      ['PNG, JPEG, WebP, SVG, GIF, PSD, .openshop', 'PNG、JPEG、WebP、SVG、GIF、PSD、.openshop'],
      ['Untitled', '未命名'],
      ['Saving', '正在保存'],
    ]

    for (const [key, translation] of dynamicLabels) {
      expectChineseTranslation(locale, key, translation)
    }

    expect(editorHtml).toContain('data-i18n="Drag to create selection.">拖动以创建选区。</span>')
    expect(editorHtml).toContain('data-i18n="PNG, JPEG, WebP, SVG, GIF, PSD, .openshop">PNG、JPEG、WebP、SVG、GIF、PSD、.openshop</div>')
    expect(editorHtml).toContain('<span id="hist-min">最小值：0</span>')
    expect(editorHtml).toContain('<dt data-i18n="Canvas">画布</dt>')

    expect(editorHtml).toContain("const labelText = this._t(labels[this._persistenceState]);")
    expect(editorHtml).toContain("label.textContent = this._t(text);")
    expect(editorHtml).toContain("document.getElementById('tool-display').textContent = this._toolLabel(tool);")
    expect(editorHtml).toContain("this._format('Cursor position: {x}, {y}'")
    expect(editorHtml).toContain("this._format('Min: {value}'")
    expect(editorHtml).toContain("this._format('{count} obj'")
    expect(editorHtml).toContain('baseline.textContent = this._t(this._historyBaseLabel);')
    expect(editorHtml).toContain('item.textContent = this._t(entry.action);')
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

  it('ships only the exact-version Fabric boot library locally with a verified hash and notice', () => {
    expect(vendorFiles).toEqual([
      'THIRD_PARTY_NOTICES.md',
      'fabric-7.4.0.min.js',
    ])

    let totalBytes = 0
    for (const asset of VENDORED_CORE_LIBRARIES) {
      const bytes = readFileSync(`public/openshop/vendor/${asset.file}`)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const sri = `sha256-${createHash('sha256').update(bytes).digest('base64')}`
      totalBytes += bytes.length

      expect(bytes.length).toBe(asset.bytes)
      expect(sha256).toBe(asset.sha256)
      expect(sri).toBe(asset.sri)
      expect(editorHtml).toContain(`url:'./vendor/${asset.file}'`)
      expect(editorHtml).not.toContain(`url:'${asset.upstream}'`)
      expect(vendorNotice).toContain(`## ${asset.name}`)
      expect(vendorNotice).toContain(`- Bytes: \`${asset.bytes}\``)
      expect(vendorNotice).toContain(`- SHA-256: \`${asset.sha256}\``)
      expect(vendorNotice).toContain(`- SRI: \`${asset.sri}\``)
      Function(String(bytes))
    }
    expect(totalBytes).toBe(299_013)
    expect(vendorNotice).toContain('Copyright (c) 2008-2015 Printio')
    expect(vendorNotice).toContain('THE SOFTWARE IS PROVIDED "AS IS"')
    expect(vendorNotice.toLowerCase()).not.toContain('ag-psd')
    expect(vendorNotice.toLowerCase()).not.toContain('jspdf')
    expect(vendorNotice).not.toContain('ag-psd-22.0.2.bundle.js')
    expect(vendorNotice).not.toContain('jspdf-4.2.1.umd.min.js')
  })

  it('loads PSD and PDF components only on demand from fixed CDN URLs with SHA-384 verification', () => {
    const requiredAssets = getWorkerStringArray('REQUIRED_ASSETS')
    const optionalAssets = getWorkerStringArray('OPTIONAL_ASSETS')

    for (const asset of VERIFIED_ON_DEMAND_LIBRARIES) {
      expect(editorHtml).toContain(`${asset.key}: Object.freeze({`)
      expect(editorHtml).toContain(`url:'${asset.url}'`)
      expect(editorHtml).toContain(`integrity:'${asset.integrity}'`)
      expect(editorHtml).not.toContain(`url:'./vendor/${asset.localFile}'`)
      expect(requiredAssets).not.toContain(asset.url)
      expect(optionalAssets).not.toContain(asset.url)
      expect(serviceWorker).not.toContain(`./vendor/${asset.localFile}`)
    }
    expect(editorHtml).toContain("await this._loadVerifiedRuntimeScript('pdfExporter'")
    expect(editorHtml).toContain("await this._loadVerifiedRuntimeScript('psdDecoder'")
    expect(editorHtml).toContain("await this._fetchVerifiedRuntimeAsset('psdDecoder')")
    expect(editorHtml).toContain('PDF 导出不可用：该功能需联网加载已验证组件。')
    expect(editorHtml).toContain('PSD 导出不可用：该功能需联网加载已验证组件。')
    expect(editorHtml).toContain('PSD 解码器不可用：该功能需联网加载已验证组件。')
    expect(editorHtml).toContain("const healthy = Boolean(this.canvas?.getObjects && typeof fabric !== 'undefined')")
  })

  it('exposes only the same-origin parent bridge path for hello, Blob configure, and PNG export', () => {
    const bridge = getEmbedBridgeSource()

    expect(bridge).toContain('_embedProtocolVersion: 1')
    expect(bridge).toContain("_embedFormats: Object.freeze(['png'])")
    expect(bridge).toContain('event.source !== window.parent || event.origin !== location.origin')
    expect(bridge).toContain("if (!bound && data.type !== 'openshop:hello' && data.type !== 'openshop:tool:hello') return;")
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

    expect(bridge).toContain("case 'openshop:tool:configure':")
    expect(bridge).toContain("case 'openshop:tool:execute':")
    expect(bridge).toContain("case 'openshop:tool:export':")
    expect(bridge).toContain("type:'openshop:tool:ready'")
    expect(bridge).toContain("type:'openshop:tool:configured'")
    expect(bridge).toContain("type:'openshop:tool:executed'")
    expect(bridge).toContain("type:'openshop:tool:exported'")
    expect(bridge).toContain("type:'openshop:tool:error'")
    expect(bridge).toContain('requestId:id')
    expect(bridge).toContain('value.requestId === value.id')
    expect(bridge).toContain("this._hasExactToolKeys(value, [...base,'commands'])")
    expect(bridge).toContain("typeof data.version !== 'number'")
    expect(editorHtml).toContain('typeof command.schemaVersion !== \'number\'')
    expect(editorHtml).toContain('!this._isToolPlainObject(command.args)')
    expect(bridge).toContain('Tool input MIME does not match its magic bytes')
    expect(bridge).toContain("commands:['canvas.crop','canvas.rotate','canvas.flip','canvas.flatten']")
    expect(bridge).toContain("this._embedNamespace !== 'tool' || this._toolSessionId !== sessionId")
    expect(bridge).toContain('this._executeToolBatch(data.commands)')
    expect(editorHtml).toContain('_executeToolBatch(commands)')
    expect(editorHtml).toContain("new Set(['canvas.crop','canvas.rotate','canvas.flip','canvas.flatten'])")
    expect(editorHtml).toContain('commands.length < 1 || commands.length > 5')
    expect(editorHtml).toContain('cropWidth * cropHeight > 80000000')
    expect(editorHtml).toContain("await this._loadDocumentState(JSON.parse(beforeSnapshot), { trusted:true })")
  })

  it('executes the shipped iframe schema validators with strict request, command, response, and magic rules', () => {
    const runtime = Object.fromEntries([
      '_isToolPlainObject',
      '_hasExactToolKeys',
      '_isToolCommandSchema',
      '_isToolDocumentDescriptor',
      '_hasExpectedToolImageMagic',
      '_isToolEnvelope',
      '_isToolRequestMessage',
      '_isToolResponseMessage',
    ].map((name) => [name, compileObjectMethod(name)])) as Record<string, (...args: unknown[]) => unknown>
    ;(runtime as Record<string, unknown>)._embedProtocolVersion = 1
    const invoke = (name: string, ...args: unknown[]) => runtime[name].apply(runtime, args)
    const base = { version: 1, id: 'request-1', requestId: 'request-1', sessionId: 'session-1' }
    const validCommand = { schemaVersion: 1, id: 'canvas.rotate', target: 'document', args: { degrees: 90 } }

    expect(invoke('_isToolRequestMessage', { ...base, type: 'openshop:tool:hello' })).toBe(true)
    expect(invoke('_isToolRequestMessage', { ...base, type: 'openshop:tool:hello', extra: true })).toBe(false)
    expect(invoke('_isToolRequestMessage', { ...base, requestId: 'other', type: 'openshop:tool:hello' })).toBe(false)
    expect(invoke('_isToolRequestMessage', { ...base, type: 'openshop:tool:execute', commands: [validCommand] })).toBe(true)
    expect(invoke('_isToolRequestMessage', {
      ...base,
      type: 'openshop:tool:execute',
      commands: [{ ...validCommand, schemaVersion: '1' }],
    })).toBe(false)
    expect(invoke('_isToolRequestMessage', {
      ...base,
      type: 'openshop:tool:execute',
      commands: [{ ...validCommand, args: { degrees: '90' } }],
    })).toBe(false)
    expect(invoke('_isToolRequestMessage', {
      ...base,
      type: 'openshop:tool:execute',
      commands: [{ schemaVersion: 1, id: 'canvas.flatten', target: 'document' }],
    })).toBe(false)
    expect(invoke('_isToolRequestMessage', {
      ...base,
      type: 'openshop:tool:execute',
      commands: [{ schemaVersion: 1, id: 'canvas.flatten', target: 'document', args: [] }],
    })).toBe(false)
    expect(invoke('_isToolRequestMessage', {
      ...base,
      type: 'openshop:tool:execute',
      commands: [{ ...validCommand, extra: true }],
    })).toBe(false)

    const error = {
      ...base,
      type: 'openshop:tool:error',
      code: 'VALIDATION_FAILED',
      message: 'invalid command',
      retryable: false,
    }
    expect(invoke('_isToolResponseMessage', error)).toBe(true)
    expect(invoke('_isToolResponseMessage', { ...error, id: '' })).toBe(false)
    expect(invoke('_isToolResponseMessage', { ...error, type: 'openshop:tool:unknown' })).toBe(false)
    expect(invoke('_isToolResponseMessage', { ...error, extra: true })).toBe(false)

    expect(invoke('_hasExpectedToolImageMagic', 'image/png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true)
    expect(invoke('_hasExpectedToolImageMagic', 'image/png', new Uint8Array([0xff, 0xd8, 0xff]))).toBe(false)
    expect(invoke('_hasExpectedToolImageMagic', 'image/jpeg', new Uint8Array([0xff, 0xd8, 0xff]))).toBe(true)
    expect(invoke('_hasExpectedToolImageMagic', 'image/webp', new TextEncoder().encode('RIFF1234WEBP'))).toBe(true)
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

  it('describes the offline boundary without claiming PSD/PDF or standalone CDN guarantees', () => {
    const locale = getChineseLocaleSource()
    const hosted = 'This hosted copy stages a verified application shell. Core editing and the OpenShop Tool runner can work offline once the shell is ready. PSD import/export and PDF export need a connection when their verified components are first loaded.'
    const standalone = 'This standalone distribution keeps the core editor and OpenShop Tool runtime in local files. Once OpenShop has opened, core editing and the Tool runner do not need a network connection. PSD import/export and PDF export need a connection when their verified components are first loaded. file:// cannot install a service worker.'

    expectChineseTranslation(locale, hosted, '此托管副本会准备经验证的应用外壳。外壳就绪后，核心编辑与 OpenShop Tool 可离线使用；PSD 导入/导出和 PDF 导出首次加载已验证组件时需要联网。')
    expectChineseTranslation(locale, standalone, '此独立发行版将核心编辑器与 OpenShop Tool 运行时保存在本地文件中。OpenShop 启动后，核心编辑与 Tool 无需联网；PSD 导入/导出和 PDF 导出首次加载已验证组件时需要联网。file:// 无法安装 Service Worker。')
    expect(editorHtml.match(new RegExp(escapeRegExp(hosted), 'g'))).toHaveLength(2)
    expect(editorHtml.match(new RegExp(escapeRegExp(standalone), 'g'))).toHaveLength(2)
    expect(editorHtml).not.toContain('Core editing, PSD import, and standard export can reload without a connection')
    expect(editorHtml).not.toContain('loads its core libraries from pinned CDNs')
    expect(hosted).not.toMatch(/cached|cache|subsequent/i)
    expect(standalone).not.toMatch(/cached|cache|subsequent/i)
  })

  it('publishes host.5 with only host.4 as the verified v0.24 rollback shell', () => {
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

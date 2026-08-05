// 此项目的浏览器 tsconfig 不引入 Node 类型；Vitest 运行时仍提供这些内置模块。
// @ts-expect-error node:fs 仅用于验证发布到 public 的 OpenShop 外壳
import { readFileSync } from 'node:fs'
// @ts-expect-error node:crypto 仅用于验证 CSP inline-script hash
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const HOST_VERSION = '0.24.0-host.1'
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

describe('OpenShop v0.24-host.1 发布产物契约', () => {
  it('uses the v0.24 host baseline and defaults to Simplified Chinese', () => {
    expect(editorHtml).toContain('<html lang="zh-CN">')
    expect(editorHtml).toContain('<title>OpenShop v0.24.0-host.1 — 在线图像编辑器</title>')
    expect(editorHtml).toContain("_lang: 'zh'")
    expect(editorHtml).toContain("this.setLocale(localStorage.getItem('os_lang') === 'en' ? 'en' : 'zh')")
    expect(editorHtml).toContain(`appVersion: '${HOST_VERSION}'`)
    expect(manifest.version).toBe(HOST_VERSION)
    expect(manifest.name).toBe('OpenShop 图像编辑器')
    expect(manifest.description).toContain('私密的浏览器端图像编辑器')
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

  it('publishes only the v0.24 shell revision and its matching core dependency list', () => {
    const revision = serviceWorker.match(/const SHELL_REVISION = '([^']+)'/)?.[1]
    const trustedRevisions = serviceWorker.match(/const TRUSTED_SHELL_REVISIONS = new Set\(\s*\[([\s\S]*?)\]\s*\);/)?.[1] ?? ''
    const requiredAssets = getWorkerStringArray('REQUIRED_ASSETS')

    expect(revision).toBe(HOST_VERSION)
    expect(trustedRevisions.trim()).toBe('SHELL_REVISION')
    expect(serviceWorker).not.toMatch(/["']0\.29(?:\.0)?(?:-r\d+)?["']/)
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

// 此项目的浏览器 tsconfig 不引入 Node 类型；Vitest 运行时仍提供这些内置模块。
// @ts-expect-error node:fs 仅用于验证发布到 public 的 OpenShop 外壳
import { readFileSync } from 'node:fs'
// @ts-expect-error node:crypto 仅用于验证 CSP inline-script hash
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const editorHtml = readFileSync('public/openshop/index.html', 'utf8')
const manifest = JSON.parse(readFileSync('public/openshop/manifest.webmanifest', 'utf8')) as {
  name: string
  description: string
}
const serviceWorker = readFileSync('public/openshop/sw.js', 'utf8')

describe('OpenShop 简体中文外壳', () => {
  it('defaults the static editor and its first-run locale to Simplified Chinese', () => {
    expect(editorHtml).toContain('<html lang="zh-CN">')
    expect(editorHtml).toContain("_lang: 'zh'")
    expect(editorHtml).toContain("preferences: { language:'zh'")
    expect(editorHtml).toContain("this.setLocale(localStorage.getItem('os_lang') === 'en' ? 'en' : 'zh')")
    expect(editorHtml).toContain('在线图像编辑器')
    expect(manifest.name).toBe('OpenShop 图像编辑器')
    expect(manifest.description).toContain('私密的浏览器端图像编辑器')
  })

  it('keeps every registered tool name and family in the Chinese dictionary', () => {
    const localeSection = editorHtml.match(/_locales: \{ en: \{\}, zh: \{([\s\S]*?)\n    \} \},\n    _lang:/)?.[1] ?? ''
    const registered = [...editorHtml.matchAll(/\['(?:tool|mode)\.[^']+',\s*'([^']+)',\s*'([^']+)'/g)]
      .flatMap(([, family, label]) => [family, label])
    const extensions = ['Brush', 'Pencil', 'Spray / Airbrush', 'AI Segment Select']

    for (const key of [...registered, ...extensions]) {
      expect(localeSection).toContain(`"${key}":`)
    }
    expect(editorHtml).toContain('data-i18n-tool-family')
    expect(editorHtml).toContain('data-i18n-tool-label')
    expect(editorHtml).toContain("this._t(c.cat)")
  })

  it('keeps CSP hashes synchronized with both inline editor scripts', () => {
    const policy = editorHtml.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? ''
    const scripts = [...editorHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, body]) => body)

    expect(scripts).toHaveLength(2)
    for (const script of scripts) {
      const hash = createHash('sha256').update(script, 'utf8').digest('base64')
      expect(policy).toContain(`'sha256-${hash}'`)
    }
  })

  it('preserves the embed protocol and publishes a new offline shell revision', () => {
    expect(editorHtml).toContain("type:'openshop:ready'")
    expect(editorHtml).toContain("'openshop:configure'")
    expect(editorHtml).toContain("type:'openshop:exported'")

    const revision = serviceWorker.match(/const SHELL_REVISION = '([^']+)'/)?.[1]
    expect(revision).toBe('0.29.0-r2')
    expect(serviceWorker).toContain("'0.29.0-r1'")
    expect(serviceWorker).toContain('OpenShop 尚未完成离线准备')
  })
})

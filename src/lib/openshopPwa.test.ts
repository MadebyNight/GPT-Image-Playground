// 此项目的浏览器 tsconfig 不引入 Node 类型；Vitest 运行时仍提供该内置模块。
// @ts-expect-error node:fs 仅用于验证发布到 public 的 Service Worker 文本
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('OpenShop PWA boundary', () => {
  const serviceWorker = readFileSync('public/sw.js', 'utf8')

  it('does not delete OpenShop cache namespaces during activation', () => {
    expect(serviceWorker).toContain("const CACHE_PREFIX = 'gpt-image-playground-'")
    expect(serviceWorker).toContain('key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME')
  })

  it('leaves OpenShop requests to the editor service worker', () => {
    expect(serviceWorker).toContain("url.pathname.includes('/openshop/')")
  })
})

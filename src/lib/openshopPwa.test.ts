// 此项目的浏览器 tsconfig 不引入 Node 类型；Vitest 运行时仍提供该内置模块。
// @ts-expect-error node:fs 仅用于验证发布到 public 的 Service Worker 文本
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('OpenShop PWA boundary', () => {
  const serviceWorker = readFileSync('public/sw.js', 'utf8')
  const mainEntry = readFileSync('src/main.tsx', 'utf8')

  it('uses a new main-app cache strategy without deleting OpenShop caches', () => {
    const cacheName = serviceWorker.match(/const CACHE_NAME\s*=\s*['"]([^'"]+)['"]/)?.[1]
    const cachePrefix = serviceWorker.match(/const CACHE_PREFIX\s*=\s*['"]([^'"]+)['"]/)?.[1]

    expect(cacheName).toBeTruthy()
    expect(cachePrefix).toBe('gpt-image-playground-')
    expect(cacheName).toMatch(/^gpt-image-playground-.+/)
    expect(cacheName).not.toBe('gpt-image-playground-v0.1.5')
    expect(serviceWorker).toMatch(
      /key\.startsWith\(\s*CACHE_PREFIX\s*\)\s*&&\s*key\s*!==\s*CACHE_NAME/,
    )
  })

  it('refreshes the offline index from an HTTP-cache-bypassing navigation request', () => {
    expect(serviceWorker).toMatch(
      /if\s*\(\s*request\.mode\s*===\s*['"]navigate['"]\s*\)\s*\{[\s\S]*?fetch\s*\(\s*request\s*,\s*\{[\s\S]*?cache\s*:\s*['"]no-store['"][\s\S]*?\}\s*\)/,
    )
    expect(serviceWorker).toMatch(
      /fetch\s*\(\s*request\s*,[\s\S]*?response\.clone\(\)[\s\S]*?cache\.put\(\s*['"]\.\/index\.html['"]\s*,[\s\S]*?\.catch\(\s*\(\)\s*=>\s*caches\.match\(\s*['"]\.\/index\.html['"]\s*\)\s*\)/,
    )
  })

  it('keeps non-navigation assets cache-first', () => {
    expect(serviceWorker).toMatch(
      /caches\.match\(\s*request\s*\)[\s\S]*?if\s*\(\s*cached\s*\)\s*return\s+cached[\s\S]*?fetch\s*\(\s*request\s*\)/,
    )
  })

  it('always checks the service worker script for updates', () => {
    expect(mainEntry).toMatch(
      /navigator\.serviceWorker\.register\([\s\S]*?,\s*\{[\s\S]*?updateViaCache\s*:\s*['"]none['"][\s\S]*?\}\s*\)/,
    )
  })

  it('leaves OpenShop requests to the editor service worker before navigation handling', () => {
    const openShopBoundary = serviceWorker.match(
      /if\s*\(\s*url\.pathname\.includes\(\s*['"]\/openshop\/['"]\s*\)\s*\)\s*return/,
    )
    const navigationHandler = serviceWorker.match(
      /if\s*\(\s*request\.mode\s*===\s*['"]navigate['"]\s*\)/,
    )

    expect(openShopBoundary).not.toBeNull()
    expect(navigationHandler).not.toBeNull()
    expect(openShopBoundary!.index).toBeLessThan(navigationHandler!.index)
  })
})

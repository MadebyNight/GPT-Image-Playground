// 浏览器项目的 tsconfig 不包含 Node 类型；Vitest 运行时提供这些模块。
// @ts-expect-error node:fs 仅用于读取发布的 Service Worker
import { readFileSync } from 'node:fs'
// @ts-expect-error node:vm 仅用于执行发布的 Service Worker
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

describe('main Service Worker Agent API boundary', () => {
  it('does not serve capabilities from Cache API', () => {
    const cacheMatch = vi.fn().mockResolvedValue({ cached: 'stale capabilities' })
    const respondWith = vi.fn()
    let onFetch: ((event: { request: { method: string; url: string; mode: string }; respondWith: typeof respondWith }) => void) | undefined

    runInNewContext(readFileSync('public/sw.js', 'utf8'), {
      URL,
      self: {
        location: { origin: 'https://app.internal' },
        addEventListener: (type: string, listener: typeof onFetch) => {
          if (type === 'fetch') onFetch = listener
        },
      },
      caches: { match: cacheMatch },
    })

    expect(onFetch).toBeDefined()
    onFetch!({
      request: { method: 'GET', url: 'https://app.internal/agent-api/v1/capabilities', mode: 'cors' },
      respondWith,
    })

    expect(respondWith).not.toHaveBeenCalled()
    expect(cacheMatch).not.toHaveBeenCalled()
  })
})

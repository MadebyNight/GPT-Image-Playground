// 浏览器项目的 tsconfig 不包含 Node 类型；Vitest 运行时提供这些模块。
// @ts-expect-error node:fs 仅用于读取发布的 Service Worker
import { readFileSync } from 'node:fs'
// @ts-expect-error node:vm 仅用于执行发布的 Service Worker
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

describe('main Service Worker Agent API boundary', () => {
  const runFetch = (path: string) => {
    const cacheMatch = vi.fn().mockResolvedValue({ cached: 'shell response' })
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
      request: { method: 'GET', url: `https://app.internal${path}`, mode: 'cors' },
      respondWith,
    })

    return { cacheMatch, respondWith }
  }

  it.each([
    '/agent-api/v1/capabilities',
    '/agent-api/v1/executions/execution-1',
    '/agent-api/v1/assets/asset-1',
  ])('does not intercept or cache %s', async (path) => {
    const { cacheMatch, respondWith } = runFetch(path)

    await Promise.resolve()
    expect(respondWith).not.toHaveBeenCalled()
    expect(cacheMatch).not.toHaveBeenCalled()
  })

  it('still serves other same-origin GET requests through Cache API', async () => {
    const { cacheMatch, respondWith } = runFetch('/main.js')

    expect(respondWith).toHaveBeenCalledOnce()
    await expect(respondWith.mock.calls[0][0]).resolves.toEqual({ cached: 'shell response' })
    expect(cacheMatch).toHaveBeenCalledOnce()
    expect(cacheMatch).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://app.internal/main.js' }))
  })

  it('deletes the previous shell cache on activation', async () => {
    const deleteCache = vi.fn().mockResolvedValue(true)
    const claim = vi.fn()
    const waitUntil = vi.fn()
    let onActivate: ((event: { waitUntil: typeof waitUntil }) => void) | undefined

    runInNewContext(readFileSync('public/sw.js', 'utf8'), {
      URL,
      self: {
        clients: { claim },
        addEventListener: (type: string, listener: typeof onActivate) => {
          if (type === 'activate') onActivate = listener
        },
      },
      caches: {
        keys: vi.fn().mockResolvedValue([
          'gpt-image-playground-shell-v2',
          'gpt-image-playground-shell-v3',
          'unrelated-cache',
        ]),
        delete: deleteCache,
      },
    })

    expect(onActivate).toBeDefined()
    onActivate!({ waitUntil })
    expect(waitUntil).toHaveBeenCalledOnce()
    await waitUntil.mock.calls[0][0]
    expect(deleteCache).toHaveBeenCalledExactlyOnceWith('gpt-image-playground-shell-v2')
    expect(claim).toHaveBeenCalledOnce()
  })
})

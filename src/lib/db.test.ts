import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type TaskRecord } from '../types'
import { putTask } from './db'

function createTask(): TaskRecord {
  return {
    id: 'db-transaction-task',
    prompt: 'test',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: 1,
    finishedAt: null,
    elapsed: null,
  }
}

function createIndexedDbHarness() {
  const request = {} as IDBRequest<IDBValidKey>
  const store = { put: vi.fn(() => request) } as unknown as IDBObjectStore
  const transaction = {
    objectStore: vi.fn(() => store),
    error: null,
  } as unknown as IDBTransaction
  const database = {
    transaction: vi.fn(() => transaction),
  } as unknown as IDBDatabase
  const openRequest = {
    result: database,
  } as unknown as IDBOpenDBRequest
  vi.stubGlobal('indexedDB', { open: vi.fn(() => openRequest) })
  return { openRequest, request, transaction }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dbTransaction', () => {
  it('resolves a successful request only after the transaction completes', async () => {
    const { openRequest, request, transaction } = createIndexedDbHarness()
    let settled = false
    const persisted = putTask(createTask()).finally(() => { settled = true })

    openRequest.onsuccess?.(new Event('success'))
    await Promise.resolve()
    Object.assign(request, { result: 'db-transaction-task' })
    request.onsuccess?.(new Event('success'))
    await Promise.resolve()
    expect(settled).toBe(false)

    transaction.oncomplete?.(new Event('complete'))
    await expect(persisted).resolves.toBe('db-transaction-task')
  })

  it.each(['onerror', 'onabort'] as const)('rejects when the transaction fires %s', async (eventName) => {
    const { openRequest, transaction } = createIndexedDbHarness()
    const persisted = putTask(createTask())

    openRequest.onsuccess?.(new Event('success'))
    await Promise.resolve()
    Object.assign(transaction, { error: new Error(`transaction ${eventName}`) })
    transaction[eventName]?.(new Event(eventName.slice(2)))

    await expect(persisted).rejects.toThrow(`transaction ${eventName}`)
  })
})

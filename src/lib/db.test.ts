import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type StoredImage, type StoredImageThumbnail, type TaskRecord } from '../types'
import { putTask, saveTaskWithImageAtomic } from './db'

function createTask(id = 'db-transaction-task', outputImageId = 'output-image'): TaskRecord {
  return {
    id,
    prompt: 'test',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [outputImageId],
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

type MemoryValue = StoredImage | StoredImageThumbnail | TaskRecord

class MemoryTransaction {
  oncomplete: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onabort: ((event: Event) => void) | null = null
  error: DOMException | null = null
  private operations: Array<() => void> = []
  private aborted = false
  private completed = false
  private waitingForRelease = false
  private staged = new Map<string, Map<string, MemoryValue>>()

  constructor(private readonly owner: MemoryDatabase) {}

  objectStore(name: string): IDBObjectStore {
    return {
      get: (key: IDBValidKey) => {
        const request = {} as IDBRequest<MemoryValue | undefined>
        this.operations.push(() => {
          Object.assign(request, { result: this.staged.get(name)?.get(String(key)) })
          request.onsuccess?.(new Event('success'))
        })
        return request
      },
      put: (value: MemoryValue) => {
        const request = {} as IDBRequest<IDBValidKey>
        this.operations.push(() => {
          if (this.owner.failStore === name
            || (name === 'tasks' && this.owner.failTaskIds.has(String((value as TaskRecord).id)))) {
            const error = new DOMException(`${name} request failed`, 'UnknownError')
            Object.assign(request, { error })
            this.error = error
            request.onerror?.(new Event('error'))
            if (!this.aborted) this.abort()
            return
          }
          this.staged.get(name)?.set(String((value as { id: string }).id), structuredClone(value))
          Object.assign(request, { result: (value as { id: string }).id })
          request.onsuccess?.(new Event('success'))
        })
        return request
      },
    } as unknown as IDBObjectStore
  }

  start() {
    this.staged = new Map<string, Map<string, MemoryValue>>([
      ['images', new Map(this.owner.images) as Map<string, MemoryValue>],
      ['thumbnails', new Map(this.owner.thumbnails) as Map<string, MemoryValue>],
      ['tasks', new Map(this.owner.tasks) as Map<string, MemoryValue>],
    ])
    this.drain()
  }

  private drain() {
    if (this.aborted || this.completed) return
    const operation = this.operations.shift()
    if (operation) {
      operation()
      queueMicrotask(() => this.drain())
      return
    }
    queueMicrotask(() => {
      if (this.aborted || this.completed || this.operations.length) {
        this.drain()
        return
      }
      if (this.owner.holdTransactions) {
        this.waitingForRelease = true
        return
      }
      this.complete()
    })
  }

  release() {
    if (!this.waitingForRelease || this.aborted || this.completed) return
    this.waitingForRelease = false
    this.complete()
  }

  private complete() {
    if (this.aborted || this.completed) return
    this.completed = true
    this.owner.images = new Map(this.staged.get('images') as Map<string, StoredImage>)
    this.owner.thumbnails = new Map(this.staged.get('thumbnails') as Map<string, StoredImageThumbnail>)
    this.owner.tasks = new Map(this.staged.get('tasks') as Map<string, TaskRecord>)
    this.oncomplete?.(new Event('complete'))
    this.owner.finish(this)
  }

  abort() {
    if (this.completed || this.aborted) throw new DOMException('Transaction is inactive', 'InvalidStateError')
    this.aborted = true
    queueMicrotask(() => {
      this.onabort?.(new Event('abort'))
      this.owner.finish(this)
    })
  }
}

class MemoryDatabase {
  images = new Map<string, StoredImage>()
  thumbnails = new Map<string, StoredImageThumbnail>()
  tasks = new Map<string, TaskRecord>()
  failStore: string | null = null
  failTaskIds = new Set<string>()
  holdTransactions = false
  private queue: MemoryTransaction[] = []
  private active: MemoryTransaction | null = null

  transaction(): IDBTransaction {
    const tx = new MemoryTransaction(this)
    this.queue.push(tx)
    queueMicrotask(() => this.pump())
    return tx as unknown as IDBTransaction
  }

  finish(tx: MemoryTransaction) {
    if (this.active === tx) this.active = null
    queueMicrotask(() => this.pump())
  }

  releaseActive() {
    this.active?.release()
  }

  get hasActiveTransaction() {
    return this.active !== null
  }

  private pump() {
    if (this.active) return
    const next = this.queue.shift()
    if (!next) return
    this.active = next
    next.start()
  }
}

function installAtomicHarness(database = new MemoryDatabase()) {
  class MockImage {
    naturalWidth = 4
    naturalHeight = 3
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  }
  vi.stubGlobal('Image', MockImage)
  vi.stubGlobal('document', {
    createElement: vi.fn(() => ({
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toDataURL: vi.fn(() => 'data:image/webp;base64,dGh1bWI='),
    })),
  })
  vi.stubGlobal('crypto', {
    subtle: {
      digest: vi.fn(async () => new Uint8Array([1, 2, 3, 4]).buffer),
    },
  })
  vi.stubGlobal('indexedDB', {
    open: vi.fn(() => {
      const request = { result: database } as unknown as IDBOpenDBRequest
      queueMicrotask(() => request.onsuccess?.(new Event('success')))
      return request
    }),
  })
  return database
}

function atomicSave(taskId: string, options: Partial<Parameters<typeof saveTaskWithImageAtomic>[0]> = {}) {
  return saveTaskWithImageAtomic({
    dataUrl: 'data:image/png;base64,c2FtZS1vdXRwdXQ=',
    source: 'openshop',
    createTask: (imageId) => createTask(taskId, imageId),
    ...options,
  })
}

afterEach(() => {
  vi.useRealTimers()
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

describe('saveTaskWithImageAtomic', () => {
  it('serializes concurrent same-hash saves so both Tasks commit while the asset and thumbnail are reused', async () => {
    const database = installAtomicHarness()

    const [first, second] = await Promise.all([atomicSave('task-a'), atomicSave('task-b')])

    expect(first.imageId).toBe('01020304')
    expect(second.imageId).toBe(first.imageId)
    expect(database.images.size).toBe(1)
    expect(database.thumbnails.size).toBe(1)
    expect([...database.tasks.keys()].sort()).toEqual(['task-a', 'task-b'])
  })

  it('rolls back a failing concurrent Task without deleting another transaction committed asset or thumbnail', async () => {
    const database = installAtomicHarness()
    database.failTaskIds.add('task-b')

    const first = atomicSave('task-a')
    const second = atomicSave('task-b')

    await expect(first).resolves.toMatchObject({ task: { id: 'task-a' } })
    await expect(second).rejects.toThrow('tasks request failed')
    expect(database.images.get('01020304')).toMatchObject({ source: 'openshop' })
    expect(database.thumbnails.get('01020304')).toMatchObject({ thumbnailVersion: 2 })
    expect([...database.tasks.keys()]).toEqual(['task-a'])
  })

  it('does not modify an existing asset or thumbnail when the reusing transaction fails', async () => {
    const database = installAtomicHarness()
    const existingImage: StoredImage = {
      id: '01020304',
      dataUrl: 'data:image/png;base64,ZXhpc3Rpbmc=',
      source: 'upload',
      createdAt: 7,
      width: 9,
      height: 8,
    }
    const existingThumbnail: StoredImageThumbnail = {
      id: '01020304',
      thumbnailDataUrl: 'data:image/webp;base64,ZXhpc3Rpbmc=',
      width: 9,
      height: 8,
      thumbnailVersion: 2,
    }
    database.images.set(existingImage.id, existingImage)
    database.thumbnails.set(existingThumbnail.id, existingThumbnail)
    database.failTaskIds.add('task-failed')

    await expect(atomicSave('task-failed')).rejects.toThrow('tasks request failed')

    expect(database.images.get(existingImage.id)).toEqual(existingImage)
    expect(database.thumbnails.get(existingThumbnail.id)).toEqual(existingThumbnail)
    expect(database.tasks.size).toBe(0)
  })

  it.each(['thumbnails', 'tasks'] as const)('rolls back every store when the %s request fails', async (storeName) => {
    const database = installAtomicHarness()
    database.failStore = storeName

    await expect(atomicSave(`failed-${storeName}`)).rejects.toThrow(`${storeName} request failed`)
    expect(database.images.size).toBe(0)
    expect(database.thumbnails.size).toBe(0)
    expect(database.tasks.size).toBe(0)
  })

  it('aborts an uncommitted transaction and leaves every store unchanged', async () => {
    const database = installAtomicHarness()
    database.holdTransactions = true
    const controller = new AbortController()
    const saving = atomicSave('aborted-task', { signal: controller.signal })
    await vi.waitFor(() => expect(database.hasActiveTransaction).toBe(true))

    controller.abort()

    await expect(saving).rejects.toMatchObject({ name: 'AbortError' })
    expect(database.images.size).toBe(0)
    expect(database.thumbnails.size).toBe(0)
    expect(database.tasks.size).toBe(0)
  })

  it('times out an uncommitted transaction and leaves every store unchanged', async () => {
    vi.useFakeTimers()
    const database = installAtomicHarness()
    database.holdTransactions = true
    const saving = atomicSave('timed-out-task', { timeoutMs: 50 })
    const assertion = expect(saving).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(50)

    await assertion
    expect(database.images.size).toBe(0)
    expect(database.thumbnails.size).toBe(0)
    expect(database.tasks.size).toBe(0)
  })

  it('calls onCommit only from transaction.oncomplete and ignores abort after commit', async () => {
    installAtomicHarness()
    const controller = new AbortController()
    const onCommit = vi.fn(() => controller.abort())

    await expect(atomicSave('committed-task', { signal: controller.signal, onCommit })).resolves.toMatchObject({
      task: { id: 'committed-task' },
    })
    expect(onCommit).toHaveBeenCalledOnce()
  })
})

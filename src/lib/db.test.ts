import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PARAMS,
  type OpenShopToolLocalRun,
  type OpenShopToolOutputDraft,
  type StoredImage,
  type StoredImageThumbnail,
  type TaskRecord,
  type ToolAgentPlan,
} from '../types'
import {
  claimOpenShopToolLocalRun,
  cleanupExpiredOpenShopToolOutputDrafts,
  createOpenShopToolLocalRunRecord,
  createOpenShopToolOutputDraftRecord,
  decodeOpenShopToolLocalRun,
  decodeOpenShopToolOutputDraft,
  getOpenShopToolLocalRun,
  putTask,
  saveTaskWithImageAtomic,
  transitionOpenShopToolLocalRun,
} from './db'

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

type MemoryValue = StoredImage | StoredImageThumbnail | TaskRecord | OpenShopToolLocalRun | OpenShopToolOutputDraft

function fakeDigestBytes(bytes: Uint8Array) {
  const digest = new Uint8Array(32)
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  for (let index = 0; index < digest.length; index += 1) {
    hash ^= index + bytes.length
    hash = Math.imul(hash, 0x27d4eb2d)
    digest[index] = hash >>> ((index % 4) * 8) & 0xff
  }
  return digest
}

function fakeDigestHex(value: string) {
  return Array.from(fakeDigestBytes(new TextEncoder().encode(value)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

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
          if (this.failRequest(request, name, 'get')) return
          Object.assign(request, { result: this.staged.get(name)?.get(String(key)) })
          request.onsuccess?.(new Event('success'))
        })
        return request
      },
      getAll: () => {
        const request = {} as IDBRequest<MemoryValue[]>
        this.operations.push(() => {
          if (this.failRequest(request, name, 'getAll')) return
          Object.assign(request, { result: [...(this.staged.get(name)?.values() ?? [])] })
          request.onsuccess?.(new Event('success'))
        })
        return request
      },
      add: (value: MemoryValue) => {
        const request = {} as IDBRequest<IDBValidKey>
        this.operations.push(() => {
          if (this.failRequest(request, name, 'add')) return
          const key = 'id' in value ? value.id : value.runId
          if (this.staged.get(name)?.has(String(key))) {
            this.rejectRequest(request, new DOMException(`${name} key exists`, 'ConstraintError'))
            return
          }
          this.staged.get(name)?.set(String(key), structuredClone(value))
          Object.assign(request, { result: key })
          request.onsuccess?.(new Event('success'))
        })
        return request
      },
      put: (value: MemoryValue) => {
        const request = {} as IDBRequest<IDBValidKey>
        this.operations.push(() => {
          if (this.owner.failOperations.has(`put:${name}`)
            || this.owner.failStore === name
            || (name === 'tasks' && this.owner.failTaskIds.has(String((value as TaskRecord).id)))) {
            this.rejectRequest(request, new DOMException(`${name} request failed`, 'UnknownError'))
            return
          }
          const key = 'id' in value ? value.id : value.runId
          this.staged.get(name)?.set(String(key), structuredClone(value))
          Object.assign(request, { result: key })
          request.onsuccess?.(new Event('success'))
        })
        return request
      },
      delete: (key: IDBValidKey) => {
        const request = {} as IDBRequest<undefined>
        this.operations.push(() => {
          if (this.failRequest(request, name, 'delete')) return
          this.staged.get(name)?.delete(String(key))
          Object.assign(request, { result: undefined })
          request.onsuccess?.(new Event('success'))
        })
        return request
      },
    } as unknown as IDBObjectStore
  }

  private failRequest(request: IDBRequest, storeName: string, operation: string) {
    if (!this.owner.failOperations.has(`${operation}:${storeName}`)) return false
    this.rejectRequest(request, new DOMException(`${storeName} ${operation} request failed`, 'UnknownError'))
    return true
  }

  private rejectRequest(request: IDBRequest, error: DOMException) {
    Object.assign(request, { error })
    this.error = error
    request.onerror?.(new Event('error'))
    if (!this.aborted) this.abort()
  }

  start() {
    this.staged = new Map<string, Map<string, MemoryValue>>([
      ['images', new Map(this.owner.images) as Map<string, MemoryValue>],
      ['thumbnails', new Map(this.owner.thumbnails) as Map<string, MemoryValue>],
      ['tasks', new Map(this.owner.tasks) as Map<string, MemoryValue>],
      ['toolRuns', new Map(this.owner.toolRuns) as Map<string, MemoryValue>],
      ['toolRunBlobs', new Map(this.owner.toolRunBlobs) as Map<string, MemoryValue>],
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
    this.owner.toolRuns = new Map(this.staged.get('toolRuns') as Map<string, OpenShopToolLocalRun>)
    this.owner.toolRunBlobs = new Map(this.staged.get('toolRunBlobs') as Map<string, OpenShopToolOutputDraft>)
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
  toolRuns = new Map<string, OpenShopToolLocalRun>()
  toolRunBlobs = new Map<string, OpenShopToolOutputDraft>()
  failStore: string | null = null
  failTaskIds = new Set<string>()
  failOperations = new Set<string>()
  holdTransactions = false
  close = vi.fn()
  transactionCalls = 0
  private queue: MemoryTransaction[] = []
  private active: MemoryTransaction | null = null

  transaction(): IDBTransaction {
    this.transactionCalls += 1
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
      digest: vi.fn(async (_algorithm: AlgorithmIdentifier, data: BufferSource) => {
        const bytes = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        return fakeDigestBytes(bytes).buffer
      }),
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

const localPlan: ToolAgentPlan = {
  schemaVersion: 2,
  composerSnapshotHash: 'a'.repeat(64),
  id: '11111111-1111-4111-8111-111111111111',
  version: 1,
  status: 'awaiting_confirmation',
  expiresAt: '2099-01-01T00:00:00.000Z',
  originalRequest: 'rotate',
  summary: 'rotate',
  operation: {
    type: 'openshop.edit',
    inputAssetId: '22222222-2222-4222-8222-222222222222',
    commands: [{ schemaVersion: 1, id: 'canvas.rotate', target: 'document', args: { degrees: 90 } }],
    outputFormat: 'png',
  },
  inputs: [{
    assetId: '22222222-2222-4222-8222-222222222222', role: 'reference', sha256: 'b'.repeat(64),
    mimeType: 'image/png', width: 1, height: 1,
  }],
  assumptions: [],
  warnings: [],
  policyVersion: 'tool-operation-v2',
}
const ATOMIC_IMAGE_ID = fakeDigestHex('data:image/png;base64,c2FtZS1vdXRwdXQ=')

async function createLocalRun(status: OpenShopToolLocalRun['status'] = 'saving'): Promise<OpenShopToolLocalRun> {
  const now = 1
  const id = `openshop:${localPlan.id}:${localPlan.version}:${localPlan.composerSnapshotHash}`
  return createOpenShopToolLocalRunRecord({
    id,
    idempotencyKey: id,
    taskId: `agent-openshop-${localPlan.id}-${localPlan.version}-${localPlan.composerSnapshotHash}`,
    planId: localPlan.id,
    planVersion: localPlan.version,
    composerSnapshotHash: localPlan.composerSnapshotHash,
    composerSnapshotVersion: 1,
    planSnapshot: localPlan,
    sourceTaskId: null,
    inputImageId: 'input-image',
    inputBinding: {
      gatewayAssetId: localPlan.operation.type === 'openshop.edit' ? localPlan.operation.inputAssetId : '',
      browserImageId: 'input-image',
      sourceTaskId: null,
      role: 'reference',
      ordinal: 0,
    },
    taskParams: { ...DEFAULT_PARAMS },
    commands: localPlan.operation.type === 'openshop.edit' ? localPlan.operation.commands : [],
    outputFormat: 'png',
    blobId: status === 'saving' ? 'openshop-blob:fixture' : null,
    status,
    saveStatus: status === 'saving' ? 'saving' : 'not_started',
    error: null,
    errorStage: null,
    createdAt: now,
    startedAt: now,
    exportedAt: status === 'saving' ? now : null,
    updatedAt: now,
    completedAt: null,
  })
}

function createOutputDraft(runId: string): Promise<OpenShopToolOutputDraft> {
  return createOpenShopToolOutputDraftRecord({
    runId,
    blob: new Blob(['png'], { type: 'image/png' }),
    filename: 'output.png',
    document: { canvas: { width: 4, height: 3 }, primaryImage: { present: true } },
    createdAt: 1,
    expiresAt: Date.now() + 10_000,
  })
}

async function resealLocalRun(
  run: OpenShopToolLocalRun,
  overrides: Partial<OpenShopToolLocalRun>,
): Promise<OpenShopToolLocalRun> {
  const candidate = { ...run, ...overrides }
  const { schemaVersion: _schemaVersion, identitySha256: _identitySha256, ...input } = candidate
  return createOpenShopToolLocalRunRecord(input)
}

function createCompletedTaskForRun(run: OpenShopToolLocalRun, imageId: string): TaskRecord {
  return {
    ...createTask(run.taskId, imageId),
    prompt: run.planSnapshot.originalRequest,
    params: { ...run.taskParams },
    inputImageIds: [run.inputImageId],
    status: 'done',
    origin: 'restricted-agent',
    sourceTaskId: run.sourceTaskId ?? undefined,
    agentPlanId: run.planId,
    agentOriginalRequest: run.planSnapshot.originalRequest,
    agentPlanSnapshot: run.planSnapshot,
    agentRunId: run.id,
    agentLocalRunId: run.id,
    agentLocalRunStatus: 'completed',
    agentLocalSaveStatus: 'completed',
  }
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

describe('OpenShop persistence integrity', () => {
  it('接受状态机定义的全部唯一合法 Run tuple', async () => {
    installAtomicHarness()
    const running = await createLocalRun('running')
    const saveError = { code: 'SAVE_FAILED', message: 'save failed', retryable: true }
    const terminalError = { code: 'TERMINAL', message: 'terminal', retryable: false }
    const cases: OpenShopToolLocalRun[] = [
      running,
      { ...running, status: 'exported', saveStatus: 'pending', blobId: 'blob', exportedAt: 2, updatedAt: 2 },
      {
        ...running, status: 'exported', saveStatus: 'failed', blobId: 'blob', exportedAt: 2,
        error: saveError, errorStage: 'save', updatedAt: 3,
      },
      { ...running, status: 'saving', saveStatus: 'saving', blobId: 'blob', exportedAt: 2, updatedAt: 3 },
      {
        ...running, status: 'completed', saveStatus: 'completed', blobId: null, exportedAt: 2,
        updatedAt: 4, completedAt: 4,
      },
      {
        ...running, status: 'failed', saveStatus: 'not_started', error: terminalError,
        errorStage: 'execution', updatedAt: 3,
      },
      {
        ...running, status: 'cancelled', saveStatus: 'not_started', error: terminalError,
        errorStage: 'execution', updatedAt: 3,
      },
      {
        ...running, status: 'interrupted', saveStatus: 'not_started', error: terminalError,
        errorStage: 'recovery', updatedAt: 3,
      },
      {
        ...running, status: 'expired', saveStatus: 'failed', blobId: null, exportedAt: 2,
        error: terminalError, errorStage: 'expiry', updatedAt: 4,
      },
    ]

    for (const run of cases) await expect(decodeOpenShopToolLocalRun(run)).resolves.toMatchObject({ status: run.status })
  })

  it.each([
    ['completed/not_started', (run: OpenShopToolLocalRun) => ({
      ...run, status: 'completed' as const, saveStatus: 'not_started' as const,
      exportedAt: 2, updatedAt: 3, completedAt: 3,
    })],
    ['completed 无 completedAt', (run: OpenShopToolLocalRun) => ({
      ...run, status: 'completed' as const, saveStatus: 'completed' as const,
      exportedAt: 2, updatedAt: 3, completedAt: null,
    })],
    ['exported 无 blob', (run: OpenShopToolLocalRun) => ({
      ...run, status: 'exported' as const, saveStatus: 'pending' as const,
      exportedAt: 2, updatedAt: 2,
    })],
    ['saving 无 blob', (run: OpenShopToolLocalRun) => ({
      ...run, status: 'saving' as const, saveStatus: 'saving' as const,
      exportedAt: 2, updatedAt: 2,
    })],
    ['failed 带 completedAt', (run: OpenShopToolLocalRun) => ({
      ...run, status: 'failed' as const, saveStatus: 'not_started' as const,
      error: { code: 'FAILED', message: 'failed', retryable: false }, errorStage: 'execution' as const,
      updatedAt: 3, completedAt: 3,
    })],
    ['时间倒序', (run: OpenShopToolLocalRun) => ({ ...run, startedAt: 3, updatedAt: 2 })],
  ] as const)('非法 tuple %s 在 decode/claim/CAS 前 fail-closed', async (_name, damage) => {
    const database = installAtomicHarness()
    const running = await createLocalRun('running')
    const invalid = damage(running) as OpenShopToolLocalRun

    await expect(decodeOpenShopToolLocalRun(invalid)).rejects.toMatchObject({ code: 'INVALID_RUN' })
    await expect(claimOpenShopToolLocalRun(invalid)).rejects.toMatchObject({ code: 'INVALID_RUN' })
    expect(database.toolRuns.size).toBe(0)
    if (_name !== '时间倒序') {
      database.toolRuns.set(running.id, running)
      await expect(transitionOpenShopToolLocalRun(running.id, ['running'], {
        status: invalid.status,
        saveStatus: invalid.saveStatus,
        blobId: invalid.blobId,
        error: invalid.error,
        errorStage: invalid.errorStage,
        exportedAt: invalid.exportedAt,
        updatedAt: invalid.updatedAt,
        completedAt: invalid.completedAt,
      })).rejects.toMatchObject({ code: 'INVALID_RUN' })
      expect(database.toolRuns.get(running.id)).toEqual(running)
    }
  })

  it('completed Run 持久化读取要求确定性 Task 与输出图片证据同时存在', async () => {
    const database = installAtomicHarness()
    const running = await createLocalRun('running')
    const completed: OpenShopToolLocalRun = {
      ...running, status: 'completed', saveStatus: 'completed', blobId: null,
      exportedAt: 2, updatedAt: 3, completedAt: 3,
    }
    database.toolRuns.set(completed.id, completed)

    await expect(getOpenShopToolLocalRun(completed.id)).rejects.toMatchObject({ code: 'INVALID_RUN' })
    await expect(claimOpenShopToolLocalRun(running)).rejects.toMatchObject({ code: 'INVALID_RUN' })
    const imageId = 'completed-output'
    database.tasks.set(completed.taskId, createCompletedTaskForRun(completed, imageId))
    await expect(getOpenShopToolLocalRun(completed.id)).rejects.toMatchObject({ code: 'INVALID_RUN' })
    database.images.set(imageId, { id: imageId, dataUrl: 'data:image/png;base64,cG5n', source: 'openshop' })

    await expect(getOpenShopToolLocalRun(completed.id)).resolves.toMatchObject({ status: 'completed' })
    await expect(claimOpenShopToolLocalRun(running)).resolves.toMatchObject({
      run: { status: 'completed' }, created: false,
    })
  })

  it('Run 与 Draft 对未知 schema、额外字段和损坏 shape 均 fail-closed', async () => {
    installAtomicHarness()
    const run = await createLocalRun('running')
    const draft = await createOutputDraft(run.id)

    await expect(decodeOpenShopToolLocalRun({ ...run, schemaVersion: 2 })).rejects.toMatchObject({ code: 'INVALID_RUN' })
    await expect(decodeOpenShopToolLocalRun({ ...run, unexpected: true })).rejects.toMatchObject({ code: 'INVALID_RUN' })
    await expect(decodeOpenShopToolLocalRun({ ...run, taskParams: { ...run.taskParams, extra: true } })).rejects.toMatchObject({ code: 'INVALID_RUN' })
    await expect(decodeOpenShopToolOutputDraft({ ...draft, schemaVersion: 2 })).rejects.toMatchObject({ code: 'INVALID_DRAFT' })
    await expect(decodeOpenShopToolOutputDraft({ ...draft, unexpected: true })).rejects.toMatchObject({ code: 'INVALID_DRAFT' })
  })

  it.each(['source', 'input', 'params', 'commands', 'identitySha256'] as const)(
    'Run 的 %s 身份字段被篡改时 canonical SHA-256 校验拒绝读取',
    async (tamper) => {
      installAtomicHarness()
      const run = await createLocalRun('running')
      let damaged: OpenShopToolLocalRun = structuredClone(run)
      if (tamper === 'source') {
        damaged = { ...damaged, sourceTaskId: 'other-source', inputBinding: { ...damaged.inputBinding, sourceTaskId: 'other-source' } }
      }
      if (tamper === 'input') {
        damaged = { ...damaged, inputImageId: 'other-input', inputBinding: { ...damaged.inputBinding, browserImageId: 'other-input' } }
      }
      if (tamper === 'params') damaged = { ...damaged, taskParams: { ...damaged.taskParams, quality: 'low' } }
      if (tamper === 'commands') {
        const commands = [{ schemaVersion: 1 as const, id: 'canvas.flip' as const, target: 'document' as const, args: { axis: 'h' as const } }]
        if (damaged.planSnapshot.operation.type !== 'openshop.edit') throw new Error('Expected openshop.edit fixture')
        damaged = {
          ...damaged,
          commands,
          planSnapshot: {
            ...damaged.planSnapshot,
            operation: { ...damaged.planSnapshot.operation, commands },
          },
        }
      }
      if (tamper === 'identitySha256') damaged = { ...damaged, identitySha256: 'c'.repeat(64) }

      await expect(decodeOpenShopToolLocalRun(damaged)).rejects.toMatchObject({ code: 'INVALID_RUN' })
    },
  )

  it('Draft 在 MIME 与 size 相同但 bytes 不同时由 blobSha256 fail-closed', async () => {
    installAtomicHarness()
    const run = await createLocalRun('running')
    const draft = await createOpenShopToolOutputDraftRecord({
      runId: run.id,
      blob: new Blob(['abcd'], { type: 'image/png' }),
      filename: 'output.png',
      document: { canvas: { width: 1, height: 1 }, primaryImage: { present: true } },
      createdAt: 1,
      expiresAt: 2,
    })
    const damaged = { ...draft, blob: new Blob(['wxyz'], { type: 'image/png' }) }

    expect(damaged.blob.size).toBe(draft.blob.size)
    await expect(decodeOpenShopToolOutputDraft(damaged)).rejects.toMatchObject({ code: 'INVALID_DRAFT' })
  })

  it('claim 相同 Run ID 但 canonical identity 不同时拒绝且不覆盖 durable Run', async () => {
    const database = installAtomicHarness()
    const durable = await createLocalRun('running')
    const conflicting = await resealLocalRun(durable, { createdAt: 2, startedAt: 2, updatedAt: 2 })
    database.toolRuns.set(durable.id, durable)

    await expect(claimOpenShopToolLocalRun(conflicting)).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })
    expect(database.toolRuns.get(durable.id)).toEqual(durable)
  })

  it('持久化读取损坏 Run fail-closed，CAS patch 运行时拒绝不可变字段', async () => {
    const database = installAtomicHarness()
    const run = await createLocalRun('running')
    database.toolRuns.set(run.id, { ...run, identitySha256: 'd'.repeat(64) })

    await expect(getOpenShopToolLocalRun(run.id)).rejects.toMatchObject({ code: 'INVALID_RUN' })
    await expect(transitionOpenShopToolLocalRun(run.id, ['running'], {
      planId: 'tampered-plan',
    } as never)).rejects.toMatchObject({ code: 'INVALID_RUN' })
    expect(database.toolRuns.get(run.id)?.planId).toBe(run.planId)
  })

  it('TTL cleanup 在单 transaction 中将 exported Run 标记 expired 并删除 Blob', async () => {
    const database = installAtomicHarness()
    const base = await createLocalRun('running')
    const draft = await createOpenShopToolOutputDraftRecord({
      runId: base.id,
      blob: new Blob(['png'], { type: 'image/png' }),
      filename: 'output.png',
      document: { canvas: { width: 1, height: 1 }, primaryImage: { present: true } },
      createdAt: 1,
      expiresAt: 2,
    })
    const exported = {
      ...base, status: 'exported' as const, saveStatus: 'pending' as const,
      blobId: draft.blobId, exportedAt: 1,
    }
    database.toolRuns.set(exported.id, exported)
    database.toolRunBlobs.set(exported.id, draft)

    await expect(cleanupExpiredOpenShopToolOutputDrafts(3)).resolves.toMatchObject([{ status: 'expired' }])
    expect(database.toolRuns.get(exported.id)).toMatchObject({ status: 'expired', saveStatus: 'failed' })
    expect(database.toolRunBlobs.has(exported.id)).toBe(false)
  })

  it('TTL cleanup 的 Draft delete request 失败时整个 transaction 回滚', async () => {
    const database = installAtomicHarness()
    const base = await createLocalRun('running')
    const draft = await createOpenShopToolOutputDraftRecord({
      runId: base.id,
      blob: new Blob(['png'], { type: 'image/png' }),
      filename: 'output.png',
      document: { canvas: { width: 1, height: 1 }, primaryImage: { present: true } },
      createdAt: 1,
      expiresAt: 2,
    })
    const exported = {
      ...base, status: 'exported' as const, saveStatus: 'pending' as const,
      blobId: draft.blobId, exportedAt: 1,
    }
    database.toolRuns.set(exported.id, exported)
    database.toolRunBlobs.set(exported.id, draft)
    database.failOperations.add('delete:toolRunBlobs')

    await expect(cleanupExpiredOpenShopToolOutputDrafts(3)).rejects.toThrow(/request|transaction/i)
    expect(database.toolRuns.get(exported.id)).toEqual(exported)
    expect(database.toolRunBlobs.get(exported.id)).toEqual(draft)
  })
})

describe('saveTaskWithImageAtomic', () => {
  it('serializes concurrent same-hash saves so both Tasks commit while the asset and thumbnail are reused', async () => {
    const database = installAtomicHarness()

    const [first, second] = await Promise.all([atomicSave('task-a'), atomicSave('task-b')])

    expect(first.imageId).toBe(ATOMIC_IMAGE_ID)
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
    expect(database.images.get(ATOMIC_IMAGE_ID)).toMatchObject({ source: 'openshop' })
    expect(database.thumbnails.get(ATOMIC_IMAGE_ID)).toMatchObject({ thumbnailVersion: 2 })
    expect([...database.tasks.keys()]).toEqual(['task-a'])
  })

  it('does not modify an existing asset or thumbnail when the reusing transaction fails', async () => {
    const database = installAtomicHarness()
    const existingImage: StoredImage = {
      id: ATOMIC_IMAGE_ID,
      dataUrl: 'data:image/png;base64,ZXhpc3Rpbmc=',
      source: 'upload',
      createdAt: 7,
      width: 9,
      height: 8,
    }
    const existingThumbnail: StoredImageThumbnail = {
      id: ATOMIC_IMAGE_ID,
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
    database.releaseActive()
    await Promise.resolve()
    expect(database.images.size).toBe(0)
    expect(database.thumbnails.size).toBe(0)
    expect(database.tasks.size).toBe(0)
  })

  it('hung indexedDB.open 超时后拒绝保存，并关闭迟到成功的连接且不启动 transaction', async () => {
    vi.useFakeTimers()
    const database = installAtomicHarness()
    const openRequest = { result: database } as unknown as IDBOpenDBRequest
    const open = vi.fn(() => openRequest)
    vi.stubGlobal('indexedDB', { open })
    const saving = atomicSave('hung-open-task', { timeoutMs: 50 })
    const assertion = expect(saving).rejects.toMatchObject({ name: 'TimeoutError' })
    for (let index = 0; index < 8 && !open.mock.calls.length; index += 1) await Promise.resolve()
    expect(open).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(50)
    await assertion
    openRequest.onsuccess?.(new Event('success'))
    await Promise.resolve()

    expect(database.close).toHaveBeenCalledOnce()
    expect(database.transactionCalls).toBe(0)
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

  it('同一 transaction 提交图片、缩略图、Task、completed Run 并删除临时 Blob', async () => {
    const database = installAtomicHarness()
    const initialRun = await createLocalRun()
    const draft = await createOutputDraft(initialRun.id)
    const saving = { ...initialRun, blobId: draft.blobId }
    database.toolRuns.set(saving.id, saving)
    database.toolRunBlobs.set(saving.id, draft)
    const completed = {
      ...saving, status: 'completed' as const, saveStatus: 'completed' as const,
      blobId: null, updatedAt: 2, completedAt: 2,
    }

    await expect(atomicSave(saving.taskId, {
      createTask: (imageId) => createCompletedTaskForRun(completed, imageId),
      completeToolRun: { run: completed, draft, expectedStatus: 'saving' },
    })).resolves.toMatchObject({ task: { id: saving.taskId } })

    expect(database.images.size).toBe(1)
    expect(database.thumbnails.size).toBe(1)
    expect(database.tasks.get(saving.taskId)).toBeDefined()
    expect(database.toolRuns.get(saving.id)?.status).toBe('completed')
    expect(database.toolRunBlobs.has(saving.id)).toBe(false)
  })

  it('最终 Task request 失败时回滚 completed Run 并保留临时 Blob', async () => {
    const database = installAtomicHarness()
    const initialRun = await createLocalRun()
    const draft = await createOutputDraft(initialRun.id)
    const saving = { ...initialRun, blobId: draft.blobId }
    database.toolRuns.set(saving.id, saving)
    database.toolRunBlobs.set(saving.id, draft)
    database.failTaskIds.add(saving.taskId)
    const completed = {
      ...saving, status: 'completed' as const, saveStatus: 'completed' as const,
      blobId: null, updatedAt: 2, completedAt: 2,
    }

    await expect(atomicSave(saving.taskId, {
      createTask: (imageId) => createCompletedTaskForRun(completed, imageId),
      completeToolRun: { run: completed, draft, expectedStatus: 'saving' },
    })).rejects.toThrow('tasks request failed')

    expect(database.images.size).toBe(0)
    expect(database.thumbnails.size).toBe(0)
    expect(database.tasks.size).toBe(0)
    expect(database.toolRuns.get(saving.id)?.status).toBe('saving')
    expect(database.toolRunBlobs.has(saving.id)).toBe(true)
  })

  it.each(['plan', 'hash', 'input', 'task', 'blob', 'operation'] as const)(
    '篡改 %s 上下文时 abort 并回滚 Run、Blob、Task、图片和缩略图',
    async (tamper) => {
      const database = installAtomicHarness()
      const initialRun = await createLocalRun()
      const expectedDraft = await createOutputDraft(initialRun.id)
      const saving = { ...initialRun, blobId: expectedDraft.blobId }
      const completed = {
        ...saving,
        status: 'completed' as const,
        saveStatus: 'completed' as const,
        blobId: null,
        updatedAt: 2,
        completedAt: 2,
      }
      let durableRun = structuredClone(saving)
      let durableDraft = expectedDraft

      if (tamper === 'plan') durableRun = { ...durableRun, planId: 'tampered-plan' }
      if (tamper === 'hash') durableRun = { ...durableRun, composerSnapshotHash: 'c'.repeat(64) }
      if (tamper === 'input') durableRun = { ...durableRun, inputImageId: 'tampered-input' }
      if (tamper === 'operation') {
        durableRun = {
          ...durableRun,
          commands: [{ schemaVersion: 1, id: 'canvas.flip', target: 'document', args: { axis: 'h' } }],
        }
      }
      if (tamper === 'blob') {
        durableDraft = { ...expectedDraft, blob: new Blob(['tampered-png'], { type: 'image/png' }) }
      }

      database.toolRuns.set(saving.id, durableRun)
      database.toolRunBlobs.set(saving.id, durableDraft)

      await expect(atomicSave(saving.taskId, {
        createTask: (imageId) => {
          const task = createCompletedTaskForRun(completed, imageId)
          return tamper === 'task' ? { ...task, id: 'tampered-task-id' } : task
        },
        completeToolRun: { run: completed, draft: expectedDraft, expectedStatus: 'saving' },
      })).rejects.toThrow(/OpenShop/)

      expect(database.images.size).toBe(0)
      expect(database.thumbnails.size).toBe(0)
      expect(database.tasks.size).toBe(0)
      expect(database.toolRuns.get(saving.id)).toEqual(durableRun)
      expect(database.toolRunBlobs.get(saving.id)).toMatchObject({
        runId: durableDraft.runId,
        filename: durableDraft.filename,
        createdAt: durableDraft.createdAt,
        expiresAt: durableDraft.expiresAt,
      })
      expect(database.toolRunBlobs.get(saving.id)?.blob.size).toBe(durableDraft.blob.size)
    },
  )
})

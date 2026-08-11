import type {
  OpenShopToolLocalInputBinding,
  OpenShopToolLocalRun,
  OpenShopToolLocalRunStatus,
  OpenShopToolOutputDraft,
  TaskParams,
  TaskRecord,
  StoredImage,
  StoredImageThumbnail,
} from '../types'
import { decodeRestrictedAgentPlan } from './restrictedAgentApi'
import { isOpenShopToolDocumentDescriptor, normalizeOpenShopToolCommands } from './openshopBridge'

const DB_NAME = 'gpt-image-playground'
const DB_VERSION = 3
const STORE_TASKS = 'tasks'
const STORE_IMAGES = 'images'
const STORE_THUMBNAILS = 'thumbnails'
const STORE_TOOL_RUNS = 'toolRuns'
const STORE_TOOL_RUN_BLOBS = 'toolRunBlobs'
const THUMBNAIL_MAX_SIZE = 720
const THUMBNAIL_QUALITY = 0.9
const THUMBNAIL_VERSION = 2

export const CURRENT_THUMBNAIL_VERSION = THUMBNAIL_VERSION

function openDB(signal?: AbortSignal): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    let settled = false
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(signal?.reason instanceof Error
        ? signal.reason
        : createAbortError('IndexedDB 打开已取消', 'AbortError'))
    }
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_TASKS)) {
        db.createObjectStore(STORE_TASKS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        db.createObjectStore(STORE_IMAGES, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_THUMBNAILS)) {
        db.createObjectStore(STORE_THUMBNAILS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_TOOL_RUNS)) {
        db.createObjectStore(STORE_TOOL_RUNS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_TOOL_RUN_BLOBS)) {
        db.createObjectStore(STORE_TOOL_RUN_BLOBS, { keyPath: 'runId' })
      }
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => db.close()
      if (settled || signal?.aborted) {
        db.close()
        return
      }
      settled = true
      cleanup()
      resolve(db)
    }
    req.onerror = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(req.error ?? new Error('IndexedDB 打开失败'))
    }
    req.onblocked = () => {
      // 保持请求待定；旧连接关闭后浏览器会继续升级。调用方 deadline 负责给出超时结果。
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function dbTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode)
        const store = tx.objectStore(storeName)
        let req: IDBRequest<T>
        const rejectTransaction = () => reject(tx.error ?? req?.error ?? new Error('IndexedDB transaction failed'))
        tx.oncomplete = () => resolve(req.result)
        tx.onerror = rejectTransaction
        tx.onabort = rejectTransaction
        try {
          req = fn(store)
          req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
        } catch (error) {
          reject(error)
        }
      }),
  )
}

// ===== Tool Agent 本地 OpenShop Run =====

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const RUN_SCHEMA_KEYS = [
  'schemaVersion', 'id', 'idempotencyKey', 'identitySha256', 'taskId', 'planId', 'planVersion',
  'composerSnapshotHash', 'composerSnapshotVersion', 'planSnapshot', 'sourceTaskId', 'inputImageId',
  'inputBinding', 'taskParams', 'commands', 'outputFormat', 'blobId', 'status', 'saveStatus', 'error', 'errorStage',
  'createdAt', 'startedAt', 'exportedAt', 'updatedAt', 'completedAt',
] as const
const DRAFT_SCHEMA_KEYS = [
  'schemaVersion', 'runId', 'blobId', 'blobSha256', 'blob', 'filename', 'document', 'createdAt', 'expiresAt',
] as const
const RUN_MUTABLE_PATCH_KEYS = [
  'status', 'saveStatus', 'error', 'errorStage', 'blobId', 'exportedAt', 'updatedAt', 'completedAt',
] as const

export class OpenShopPersistenceError extends Error {
  constructor(readonly code: 'INVALID_RUN' | 'INVALID_DRAFT' | 'IDENTITY_CONFLICT', message: string) {
    super(message)
    this.name = 'OpenShopPersistenceError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0)
}

function decodeOpenShopTaskParams(value: unknown): TaskParams {
  if (!isRecord(value)
    || !hasExactKeys(value, ['size', 'quality', 'output_format', 'output_compression', 'moderation', 'n'])
    || typeof value.size !== 'string' || !value.size
    || !['auto', 'low', 'medium', 'high'].includes(String(value.quality))
    || !['png', 'jpeg', 'webp'].includes(String(value.output_format))
    || !(value.output_compression === null
      || (typeof value.output_compression === 'number' && Number.isSafeInteger(value.output_compression)
        && value.output_compression >= 0 && value.output_compression <= 100))
    || !['auto', 'low'].includes(String(value.moderation))
    || typeof value.n !== 'number' || !Number.isSafeInteger(value.n) || value.n < 1 || value.n > 4) {
    throw new OpenShopPersistenceError('INVALID_RUN', 'OpenShop 本地 Run taskParams schema 无效')
  }
  return {
    size: value.size,
    quality: value.quality as TaskParams['quality'],
    output_format: value.output_format as TaskParams['output_format'],
    output_compression: value.output_format === 'png' ? null : value.output_compression ?? 90,
    moderation: value.moderation as TaskParams['moderation'],
    n: value.n,
  }
}

function decodeOpenShopInputBinding(value: unknown): OpenShopToolLocalInputBinding {
  if (!isRecord(value)
    || !hasExactKeys(value, ['gatewayAssetId', 'browserImageId', 'sourceTaskId', 'role', 'ordinal'])
    || typeof value.gatewayAssetId !== 'string' || !value.gatewayAssetId
    || typeof value.browserImageId !== 'string' || !value.browserImageId
    || !isNullableString(value.sourceTaskId)
    || value.role !== 'reference'
    || typeof value.ordinal !== 'number' || !Number.isSafeInteger(value.ordinal) || value.ordinal < 0) {
    throw new OpenShopPersistenceError('INVALID_RUN', 'OpenShop 本地 Run input binding schema 无效')
  }
  return value as unknown as OpenShopToolLocalInputBinding
}

function decodeOpenShopRunError(value: unknown): OpenShopToolLocalRun['error'] {
  if (value === null) return null
  if (!isRecord(value)
    || !hasExactKeys(value, ['code', 'message', 'retryable'])
    || typeof value.code !== 'string' || !value.code
    || typeof value.message !== 'string' || !value.message
    || typeof value.retryable !== 'boolean') {
    throw new OpenShopPersistenceError('INVALID_RUN', 'OpenShop 本地 Run error schema 无效')
  }
  return value as unknown as NonNullable<OpenShopToolLocalRun['error']>
}

/** OpenShop Run 状态机的唯一合法持久化 tuple；所有读写入口必须共用。 */
export function validateOpenShopToolRunStateTuple(run: OpenShopToolLocalRun): void {
  const errorStages = ['execution', 'save', 'recovery', 'expiry'] as const
  if (!(run.errorStage === null || errorStages.includes(run.errorStage))
    || run.createdAt > run.startedAt
    || run.startedAt > run.updatedAt
    || (run.exportedAt !== null && (run.exportedAt < run.startedAt || run.exportedAt > run.updatedAt))
    || (run.completedAt !== null && (run.completedAt < run.startedAt || run.completedAt > run.updatedAt))) {
    throw new OpenShopPersistenceError('INVALID_RUN', 'OpenShop 本地 Run 时间顺序或 errorStage 无效')
  }
  const noError = run.error === null && run.errorStage === null
  const executionTerminal = run.saveStatus === 'not_started'
    && run.blobId === null
    && run.exportedAt === null
    && run.completedAt === null
    && run.error !== null
    && run.errorStage === 'execution'
  const valid = run.status === 'running'
    ? run.saveStatus === 'not_started' && run.blobId === null && run.exportedAt === null && run.completedAt === null && noError
    : run.status === 'exported'
      ? run.blobId !== null && run.exportedAt !== null && run.completedAt === null && (
          (run.saveStatus === 'pending' && noError)
          || (run.saveStatus === 'failed' && run.error !== null && run.errorStage === 'save')
        )
      : run.status === 'saving'
        ? run.saveStatus === 'saving' && run.blobId !== null && run.exportedAt !== null && run.completedAt === null && noError
        : run.status === 'completed'
          ? run.saveStatus === 'completed' && run.blobId === null && run.exportedAt !== null && run.completedAt !== null
            && run.exportedAt <= run.completedAt && noError
          : run.status === 'failed' || run.status === 'cancelled'
            ? executionTerminal
            : run.status === 'interrupted'
              ? run.saveStatus === 'not_started' && run.blobId === null && run.exportedAt === null
                && run.completedAt === null && run.error !== null && run.errorStage === 'recovery'
              : run.status === 'expired'
                ? run.saveStatus === 'failed' && run.blobId === null && run.exportedAt !== null
                  && run.completedAt === null && run.error !== null && run.errorStage === 'expiry'
                : false
  if (!valid) {
    throw new OpenShopPersistenceError(
      'INVALID_RUN',
      `OpenShop 本地 Run 状态 tuple 无效：${run.status}/${run.saveStatus}`,
    )
  }
}

function normalizeOpenShopRunIdentityPayload(run: OpenShopToolLocalRun) {
  return {
    schemaVersion: run.schemaVersion,
    id: run.id,
    idempotencyKey: run.idempotencyKey,
    taskId: run.taskId,
    planId: run.planId,
    planVersion: run.planVersion,
    composerSnapshotHash: run.composerSnapshotHash,
    composerSnapshotVersion: run.composerSnapshotVersion,
    planSnapshot: run.planSnapshot,
    sourceTaskId: run.sourceTaskId,
    inputImageId: run.inputImageId,
    inputBinding: run.inputBinding,
    taskParams: run.taskParams,
    commands: run.commands,
    outputFormat: run.outputFormat,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
  }
}

async function sha256Hex(value: Uint8Array | string) {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持 SHA-256 完整性校验')
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value)
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes.buffer))
  if (digest.byteLength !== 32) throw new Error('SHA-256 digest 长度无效')
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function computeOpenShopRunIdentitySha256(run: OpenShopToolLocalRun) {
  return sha256Hex(JSON.stringify(canonicalJsonValue(normalizeOpenShopRunIdentityPayload(run))))
}

export async function hashOpenShopToolBlob(blob: Blob) {
  return sha256Hex(new Uint8Array(await blob.arrayBuffer()))
}

export type OpenShopToolLocalRunInput = Omit<OpenShopToolLocalRun, 'schemaVersion' | 'identitySha256'>

export async function createOpenShopToolLocalRunRecord(input: OpenShopToolLocalRunInput): Promise<OpenShopToolLocalRun> {
  const run = decodeOpenShopToolLocalRunShape({
    ...input,
    schemaVersion: 1,
    identitySha256: '0'.repeat(64),
    taskParams: decodeOpenShopTaskParams(input.taskParams),
  })
  return { ...run, identitySha256: await computeOpenShopRunIdentitySha256(run) }
}

function decodeOpenShopToolLocalRunShape(value: unknown): OpenShopToolLocalRun {
  if (!isRecord(value) || !hasExactKeys(value, RUN_SCHEMA_KEYS) || value.schemaVersion !== 1) {
    throw new OpenShopPersistenceError('INVALID_RUN', 'OpenShop 本地 Run schemaVersion 或字段无效')
  }
  const planSnapshot = decodeRestrictedAgentPlan(value.planSnapshot)
  const operation = planSnapshot.schemaVersion === 2 ? planSnapshot.operation : null
  const commands = normalizeOpenShopToolCommands(value.commands)
  const taskParams = decodeOpenShopTaskParams(value.taskParams)
  const inputBinding = decodeOpenShopInputBinding(value.inputBinding)
  const error = decodeOpenShopRunError(value.error)
  const statuses: OpenShopToolLocalRunStatus[] = [
    'running', 'exported', 'saving', 'completed', 'cancelled', 'failed', 'interrupted', 'expired',
  ]
  const saveStatuses: OpenShopToolLocalRun['saveStatus'][] = ['not_started', 'pending', 'saving', 'completed', 'failed']
  if (typeof value.id !== 'string' || !value.id
    || typeof value.idempotencyKey !== 'string' || !value.idempotencyKey
    || typeof value.identitySha256 !== 'string' || !SHA256_PATTERN.test(value.identitySha256)
    || typeof value.taskId !== 'string' || !value.taskId
    || typeof value.planId !== 'string' || !value.planId
    || typeof value.planVersion !== 'number' || !Number.isSafeInteger(value.planVersion) || value.planVersion < 1
    || typeof value.composerSnapshotHash !== 'string' || !SHA256_PATTERN.test(value.composerSnapshotHash)
    || typeof value.composerSnapshotVersion !== 'number' || !Number.isSafeInteger(value.composerSnapshotVersion) || value.composerSnapshotVersion < 0
    || !isNullableString(value.sourceTaskId)
    || typeof value.inputImageId !== 'string' || !value.inputImageId
    || value.outputFormat !== 'png'
    || !(value.blobId === null || (typeof value.blobId === 'string' && value.blobId.length > 0))
    || !statuses.includes(value.status as OpenShopToolLocalRunStatus)
    || !saveStatuses.includes(value.saveStatus as OpenShopToolLocalRun['saveStatus'])
    || !(value.errorStage === null || ['execution', 'save', 'recovery', 'expiry'].includes(String(value.errorStage)))
    || !isSafeTimestamp(value.createdAt) || !isSafeTimestamp(value.startedAt) || !isSafeTimestamp(value.updatedAt)
    || !(value.exportedAt === null || isSafeTimestamp(value.exportedAt))
    || !(value.completedAt === null || isSafeTimestamp(value.completedAt))) {
    throw new OpenShopPersistenceError('INVALID_RUN', 'OpenShop 本地 Run 字段 schema 无效')
  }
  const expectedRunId = `openshop:${value.planId}:${value.planVersion}:${value.composerSnapshotHash}`
  const expectedTaskId = `agent-openshop-${value.planId}-${value.planVersion}-${value.composerSnapshotHash}`
  if (value.id !== expectedRunId
    || value.idempotencyKey !== expectedRunId
    || value.taskId !== expectedTaskId
    || planSnapshot.schemaVersion !== 2
    || operation?.type !== 'openshop.edit'
    || planSnapshot.id !== value.planId
    || planSnapshot.version !== value.planVersion
    || planSnapshot.composerSnapshotHash !== value.composerSnapshotHash
    || operation.inputAssetId !== inputBinding.gatewayAssetId
    || inputBinding.browserImageId !== value.inputImageId
    || inputBinding.sourceTaskId !== value.sourceTaskId
    || !hasSameJsonValue(commands, operation.commands)
    || !hasSameJsonValue(taskParams, value.taskParams)) {
    throw new OpenShopPersistenceError('INVALID_RUN', 'OpenShop 本地 Run 不可变身份内部不一致')
  }
  const run = {
    ...(value as unknown as OpenShopToolLocalRun),
    planSnapshot,
    inputBinding,
    taskParams,
    commands,
    error,
  }
  validateOpenShopToolRunStateTuple(run)
  return run
}

export async function decodeOpenShopToolLocalRun(value: unknown): Promise<OpenShopToolLocalRun> {
  const run = decodeOpenShopToolLocalRunShape(value)
  if (await computeOpenShopRunIdentitySha256(run) !== run.identitySha256) {
    throw new OpenShopPersistenceError('INVALID_RUN', 'OpenShop 本地 Run identitySha256 校验失败')
  }
  return run
}

export type OpenShopToolOutputDraftInput = Omit<OpenShopToolOutputDraft, 'schemaVersion' | 'blobId' | 'blobSha256'>

export async function createOpenShopToolOutputDraftRecord(input: OpenShopToolOutputDraftInput): Promise<OpenShopToolOutputDraft> {
  const blobSha256 = await hashOpenShopToolBlob(input.blob)
  return decodeOpenShopToolOutputDraftShape({
    ...input,
    schemaVersion: 1,
    blobId: `openshop-blob:${input.runId}:${blobSha256}`,
    blobSha256,
  })
}

function decodeOpenShopToolOutputDraftShape(value: unknown): OpenShopToolOutputDraft {
  if (!isRecord(value)
    || !hasExactKeys(value, DRAFT_SCHEMA_KEYS)
    || value.schemaVersion !== 1
    || typeof value.runId !== 'string' || !value.runId
    || typeof value.blobId !== 'string' || !value.blobId
    || typeof value.blobSha256 !== 'string' || !SHA256_PATTERN.test(value.blobSha256)
    || !(value.blob instanceof Blob)
    || value.blob.type !== 'image/png'
    || typeof value.filename !== 'string' || !value.filename
    || !isOpenShopToolDocumentDescriptor(value.document)
    || !isSafeTimestamp(value.createdAt) || !isSafeTimestamp(value.expiresAt)
    || value.expiresAt <= value.createdAt
    || value.blobId !== `openshop-blob:${value.runId}:${value.blobSha256}`) {
    throw new OpenShopPersistenceError('INVALID_DRAFT', 'OpenShop 临时导出物 schema 或身份无效')
  }
  return value as unknown as OpenShopToolOutputDraft
}

export async function decodeOpenShopToolOutputDraft(value: unknown): Promise<OpenShopToolOutputDraft> {
  const draft = decodeOpenShopToolOutputDraftShape(value)
  if (await hashOpenShopToolBlob(draft.blob) !== draft.blobSha256) {
    throw new OpenShopPersistenceError('INVALID_DRAFT', 'OpenShop 临时导出物 blobSha256 校验失败')
  }
  return draft
}

function hasSameOpenShopRunIdentity(left: OpenShopToolLocalRun, right: OpenShopToolLocalRun) {
  return left.identitySha256 === right.identitySha256
    && hasSameJsonValue(normalizeOpenShopRunIdentityPayload(left), normalizeOpenShopRunIdentityPayload(right))
}

function hasSameOpenShopDraftRecord(left: OpenShopToolOutputDraft, right: OpenShopToolOutputDraft) {
  return left.schemaVersion === right.schemaVersion
    && left.runId === right.runId
    && left.blobId === right.blobId
    && left.blobSha256 === right.blobSha256
    && left.blob.size === right.blob.size
    && left.blob.type === right.blob.type
    && left.filename === right.filename
    && left.createdAt === right.createdAt
    && left.expiresAt === right.expiresAt
    && hasSameJsonValue(left.document, right.document)
}

function readOpenShopStoredValue(
  storeName: typeof STORE_TOOL_RUNS | typeof STORE_TOOL_RUN_BLOBS,
  key: string,
  signal: AbortSignal | undefined,
  label: string,
): Promise<unknown> {
  return openDB(signal).then((db) => new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const request = tx.objectStore(storeName).get(key)
    let settled = false
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const onAbort = () => {
      try { tx.abort() } catch { /* transaction 已结束 */ }
      fail(signal?.reason instanceof Error ? signal.reason : createAbortError(`${label}已取消`, 'AbortError'))
    }
    tx.oncomplete = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(request.result)
    }
    tx.onerror = () => fail(tx.error ?? request.error ?? new Error(`${label}失败`))
    tx.onabort = () => fail(tx.error ?? new Error(`${label}已中止`))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  }))
}

function waitForOpenShopPersistenceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error
      ? signal.reason
      : createAbortError(`${label}已取消`, 'AbortError'))
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(signal.reason instanceof Error ? signal.reason : createAbortError(`${label}已取消`, 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
  })
}

export function getOpenShopToolLocalRun(runId: string, signal?: AbortSignal): Promise<OpenShopToolLocalRun | undefined> {
  return readOpenShopStoredValue(STORE_TOOL_RUNS, runId, signal, 'OpenShop 本地 Run 读取')
    .then(async (value) => {
      if (value === undefined) return undefined
      const run = await waitForOpenShopPersistenceAbort(
        decodeOpenShopToolLocalRun(value), signal, 'OpenShop 本地 Run 完整性校验',
      )
      if (run.status === 'completed') {
        await waitForOpenShopPersistenceAbort(
          getVerifiedCompletedOpenShopToolTask(run, signal), signal, 'OpenShop completed Task 证据校验',
        )
      }
      return run
    })
}

/**
 * 以 Run ID（即 plan/version/snapshot 幂等键）在单个 readwrite transaction 中 claim。
 * IndexedDB 会串行化同一 store 的写 transaction，因此并发确认只能有一个 created=true。
 */
export async function claimOpenShopToolLocalRun(
  candidate: OpenShopToolLocalRun,
): Promise<{ run: OpenShopToolLocalRun; created: boolean }> {
  const verifiedCandidate = await decodeOpenShopToolLocalRun(candidate)
  const claimed = await openDB().then((db) => new Promise<{ run: OpenShopToolLocalRun; created: boolean }>((resolve, reject) => {
    const tx = db.transaction(STORE_TOOL_RUNS, 'readwrite')
    const store = tx.objectStore(STORE_TOOL_RUNS)
    const request = store.get(verifiedCandidate.id)
    let result: OpenShopToolLocalRun | null = null
    let created = false
    request.onsuccess = () => {
      if (request.result) {
        try {
          const existing = decodeOpenShopToolLocalRunShape(request.result)
          if (!hasSameOpenShopRunIdentity(existing, verifiedCandidate)) {
            throw new OpenShopPersistenceError('IDENTITY_CONFLICT', '相同 Run ID 已存在不同的不可变身份')
          }
          result = existing
        } catch (error) {
          try { tx.abort() } catch { /* transaction 已结束 */ }
          reject(error)
        }
        return
      }
      const addRequest = store.add(verifiedCandidate)
      addRequest.onsuccess = () => {
        result = verifiedCandidate
        created = true
      }
      addRequest.onerror = () => reject(addRequest.error ?? new Error('OpenShop 本地 Run claim 失败'))
    }
    request.onerror = () => reject(request.error ?? new Error('OpenShop 本地 Run claim 读取失败'))
    tx.oncomplete = () => {
      if (result) resolve({ run: result, created })
      else reject(new Error('OpenShop 本地 Run claim 未返回结果'))
    }
    tx.onerror = () => reject(tx.error ?? new Error('OpenShop 本地 Run claim transaction 失败'))
    tx.onabort = () => reject(tx.error ?? new Error('OpenShop 本地 Run claim transaction 已中止'))
  }))
  if (claimed.run.status === 'completed') await getVerifiedCompletedOpenShopToolTask(claimed.run)
  return claimed
}

export async function getVerifiedCompletedOpenShopToolTask(
  runValue: OpenShopToolLocalRun,
  signal?: AbortSignal,
): Promise<TaskRecord> {
  const run = await waitForOpenShopPersistenceAbort(
    decodeOpenShopToolLocalRun(runValue), signal, 'OpenShop completed Run 完整性校验',
  )
  if (run.status !== 'completed') {
    throw new OpenShopPersistenceError('INVALID_RUN', '只有 completed Run 才能验证最终 Task 证据')
  }
  return openDB(signal).then((db) => new Promise<TaskRecord>((resolve, reject) => {
    const tx = db.transaction([STORE_TASKS, STORE_IMAGES], 'readonly')
    const taskRequest = tx.objectStore(STORE_TASKS).get(run.taskId)
    let task: TaskRecord | null = null
    let imageRequest: IDBRequest<unknown> | null = null
    let validationError: Error | null = null
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const abort = (error: Error) => {
      validationError = error
      try { tx.abort() } catch { cleanup(); reject(error) }
    }
    const onAbort = () => abort(signal?.reason instanceof Error
      ? signal.reason
      : createAbortError('OpenShop completed Task 验证已取消', 'AbortError'))
    taskRequest.onsuccess = () => {
      const value = taskRequest.result as TaskRecord | undefined
      const outputImageId = value?.outputImages?.[0]
      if (!value || typeof outputImageId !== 'string' || !outputImageId) {
        abort(new OpenShopPersistenceError('INVALID_RUN', 'completed Run 缺少确定性 Task 或输出图片引用'))
        return
      }
      task = value
      imageRequest = tx.objectStore(STORE_IMAGES).get(outputImageId)
      imageRequest.onsuccess = () => {
        if (!imageRequest?.result) {
          abort(new OpenShopPersistenceError('INVALID_RUN', 'completed Run 的最终输出图片不存在'))
          return
        }
        const taskError = validateOpenShopCompletedTaskRecord(run, value, outputImageId)
        if (taskError) abort(taskError)
      }
      imageRequest.onerror = () => abort(imageRequest?.error ?? new Error('completed Run 输出图片读取失败'))
    }
    taskRequest.onerror = () => abort(taskRequest.error ?? new Error('completed Run Task 读取失败'))
    tx.oncomplete = () => {
      cleanup()
      if (task) resolve(task)
      else reject(new OpenShopPersistenceError('INVALID_RUN', 'completed Run Task 验证未完成'))
    }
    tx.onerror = () => { cleanup(); reject(validationError ?? tx.error ?? new Error('completed Run Task 验证失败')) }
    tx.onabort = () => { cleanup(); reject(validationError ?? tx.error ?? new Error('completed Run Task 验证已中止')) }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  }))
}

export type OpenShopToolLocalRunMutablePatch = Partial<Pick<
  OpenShopToolLocalRun,
  'status' | 'saveStatus' | 'error' | 'errorStage' | 'blobId' | 'exportedAt' | 'updatedAt' | 'completedAt'
>>

function decodeOpenShopToolLocalRunMutablePatch(value: unknown): OpenShopToolLocalRunMutablePatch {
  if (!isRecord(value) || Object.keys(value).some((key) => !RUN_MUTABLE_PATCH_KEYS.includes(key as typeof RUN_MUTABLE_PATCH_KEYS[number]))) {
    throw new OpenShopPersistenceError('INVALID_RUN', 'OpenShop Run CAS patch 包含不可变字段')
  }
  if (value.status !== undefined
    && !['running', 'exported', 'saving', 'completed', 'cancelled', 'failed', 'interrupted', 'expired'].includes(String(value.status))) {
    throw new OpenShopPersistenceError('INVALID_RUN', 'OpenShop Run CAS status 无效')
  }
  if (value.saveStatus !== undefined
    && !['not_started', 'pending', 'saving', 'completed', 'failed'].includes(String(value.saveStatus))) {
    throw new OpenShopPersistenceError('INVALID_RUN', 'OpenShop Run CAS saveStatus 无效')
  }
  if (value.error !== undefined) decodeOpenShopRunError(value.error)
  if (value.errorStage !== undefined
    && !(value.errorStage === null || ['execution', 'save', 'recovery', 'expiry'].includes(String(value.errorStage)))) {
    throw new OpenShopPersistenceError('INVALID_RUN', 'OpenShop Run CAS errorStage 无效')
  }
  if (value.blobId !== undefined && !(value.blobId === null || (typeof value.blobId === 'string' && value.blobId))) {
    throw new OpenShopPersistenceError('INVALID_RUN', 'OpenShop Run CAS blobId 无效')
  }
  if (value.updatedAt !== undefined && !isSafeTimestamp(value.updatedAt)) {
    throw new OpenShopPersistenceError('INVALID_RUN', 'OpenShop Run CAS updatedAt 无效')
  }
  if (value.exportedAt !== undefined && !(value.exportedAt === null || isSafeTimestamp(value.exportedAt))) {
    throw new OpenShopPersistenceError('INVALID_RUN', 'OpenShop Run CAS exportedAt 无效')
  }
  if (value.completedAt !== undefined && !(value.completedAt === null || isSafeTimestamp(value.completedAt))) {
    throw new OpenShopPersistenceError('INVALID_RUN', 'OpenShop Run CAS completedAt 无效')
  }
  return value as OpenShopToolLocalRunMutablePatch
}

export async function transitionOpenShopToolLocalRun(
  runId: string,
  expectedStatuses: readonly OpenShopToolLocalRunStatus[],
  patch: OpenShopToolLocalRunMutablePatch,
  signal?: AbortSignal,
): Promise<OpenShopToolLocalRun | null> {
  const verifiedPatch = decodeOpenShopToolLocalRunMutablePatch(patch)
  if (verifiedPatch.status === 'completed' || verifiedPatch.saveStatus === 'completed') {
    throw new OpenShopPersistenceError('INVALID_RUN', 'completed Run 只能由最终原子保存 transaction 提交')
  }
  const verifiedCurrent = await getOpenShopToolLocalRun(runId, signal)
  if (!verifiedCurrent) return null
  return openDB(signal).then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TOOL_RUNS, 'readwrite')
    const store = tx.objectStore(STORE_TOOL_RUNS)
    const request = store.get(runId)
    let result: OpenShopToolLocalRun | null = null
    let abortError: Error | null = null
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const onAbort = () => {
      abortError = signal?.reason instanceof Error
        ? signal.reason
        : createAbortError('OpenShop Run CAS 已取消', 'AbortError')
      try { tx.abort() } catch { reject(abortError) }
    }
    request.onsuccess = () => {
      try {
        if (!request.result) return
        const current = decodeOpenShopToolLocalRunShape(request.result)
        if (!hasSameOpenShopRunIdentity(current, verifiedCurrent)) {
          throw new OpenShopPersistenceError('IDENTITY_CONFLICT', 'OpenShop Run CAS 期间不可变身份已变化')
        }
        if (!expectedStatuses.includes(current.status)) return
        result = decodeOpenShopToolLocalRunShape({
          ...current,
          ...verifiedPatch,
          updatedAt: verifiedPatch.updatedAt ?? Date.now(),
        })
        const putRequest = store.put(result)
        putRequest.onerror = () => reject(putRequest.error ?? new Error('OpenShop 本地 Run 更新失败'))
      } catch (error) {
        try { tx.abort() } catch { /* transaction 已结束 */ }
        reject(error)
      }
    }
    request.onerror = () => reject(request.error ?? new Error('OpenShop 本地 Run 更新读取失败'))
    tx.oncomplete = () => { cleanup(); resolve(result) }
    tx.onerror = () => { cleanup(); reject(tx.error ?? new Error('OpenShop 本地 Run 更新 transaction 失败')) }
    tx.onabort = () => { cleanup(); reject(abortError ?? tx.error ?? new Error('OpenShop 本地 Run 更新 transaction 已中止')) }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  }))
}

/** Runner 导出校验完成后，将 Run=exported 与 Blob 放入同一个 transaction。 */
export function storeOpenShopToolExport(
  runId: string,
  draftInput: OpenShopToolOutputDraftInput,
): Promise<OpenShopToolLocalRun> {
  if (draftInput.runId !== runId) return Promise.reject(new Error('OpenShop 导出物与 Run ID 不一致'))
  return Promise.all([
    getOpenShopToolLocalRun(runId),
    createOpenShopToolOutputDraftRecord(draftInput),
  ]).then(([verifiedRun, draft]) => {
    if (!verifiedRun) throw new Error('OpenShop 本地 Run 不存在')
    if (verifiedRun.status !== 'running') throw new Error(`OpenShop 本地 Run 状态不允许写入导出物：${verifiedRun.status}`)
    return openDB().then((db) => new Promise<OpenShopToolLocalRun>((resolve, reject) => {
      const tx = db.transaction([STORE_TOOL_RUNS, STORE_TOOL_RUN_BLOBS], 'readwrite')
      const runs = tx.objectStore(STORE_TOOL_RUNS)
      const request = runs.get(runId)
      let result: OpenShopToolLocalRun | null = null
      request.onsuccess = () => {
        try {
          if (!request.result) throw new Error('OpenShop 本地 Run 不存在')
          const current = decodeOpenShopToolLocalRunShape(request.result)
          if (!hasSameOpenShopRunIdentity(current, verifiedRun)) {
            throw new OpenShopPersistenceError('IDENTITY_CONFLICT', 'OpenShop 导出期间 Run 不可变身份已变化')
          }
          if (current.status !== 'running') {
            throw new Error(`OpenShop 本地 Run 状态不允许写入导出物：${current.status}`)
          }
          const exportedAt = Date.now()
          result = decodeOpenShopToolLocalRunShape({
            ...current,
            status: 'exported',
            saveStatus: 'pending',
            blobId: draft.blobId,
            error: null,
            errorStage: null,
            exportedAt,
            updatedAt: exportedAt,
          })
          const runRequest = runs.put(result)
          const draftRequest = tx.objectStore(STORE_TOOL_RUN_BLOBS).put(draft)
          runRequest.onerror = () => reject(runRequest.error ?? new Error('OpenShop exported Run 保存失败'))
          draftRequest.onerror = () => reject(draftRequest.error ?? new Error('OpenShop 导出 Blob 保存失败'))
        } catch (error) {
          try { tx.abort() } catch { /* transaction 已结束 */ }
          reject(error)
        }
      }
      request.onerror = () => reject(request.error ?? new Error('OpenShop 本地 Run 读取失败'))
      tx.oncomplete = () => result ? resolve(result) : reject(new Error('OpenShop exported Run 未生成'))
      tx.onerror = () => reject(tx.error ?? new Error('OpenShop 导出持久化 transaction 失败'))
      tx.onabort = () => reject(tx.error ?? new Error('OpenShop 导出持久化 transaction 已中止'))
    }))
  })
}

export function getOpenShopToolOutputDraft(runId: string, signal?: AbortSignal): Promise<OpenShopToolOutputDraft | undefined> {
  return readOpenShopStoredValue(STORE_TOOL_RUN_BLOBS, runId, signal, 'OpenShop 临时导出物读取')
    .then((value) => value === undefined
      ? undefined
      : waitForOpenShopPersistenceAbort(
          decodeOpenShopToolOutputDraft(value), signal, 'OpenShop 临时导出物完整性校验',
        ))
}

async function getAllOpenShopToolOutputDrafts(): Promise<OpenShopToolOutputDraft[]> {
  const rawDrafts = await openDB().then((db) => new Promise<unknown[]>((resolve, reject) => {
    const tx = db.transaction(STORE_TOOL_RUN_BLOBS, 'readonly')
    const request = tx.objectStore(STORE_TOOL_RUN_BLOBS).getAll()
    tx.oncomplete = () => resolve(request.result)
    tx.onerror = () => reject(tx.error ?? request.error ?? new Error('OpenShop 临时导出物枚举失败'))
    tx.onabort = () => reject(tx.error ?? new Error('OpenShop 临时导出物枚举已中止'))
  }))
  return Promise.all(rawDrafts.map(decodeOpenShopToolOutputDraft))
}

export async function cleanupExpiredOpenShopToolOutputDrafts(now = Date.now()): Promise<OpenShopToolLocalRun[]> {
  const expiredDrafts = (await getAllOpenShopToolOutputDrafts()).filter((draft) => draft.expiresAt <= now)
  if (!expiredDrafts.length) return []
  const candidates = await Promise.all(expiredDrafts.map(async (draft) => {
    const run = await getOpenShopToolLocalRun(draft.runId)
    if (!run) throw new OpenShopPersistenceError('INVALID_DRAFT', 'OpenShop 临时导出物缺少对应 Run')
    return { draft, run }
  }))

  return openDB().then((db) => new Promise<OpenShopToolLocalRun[]>((resolve, reject) => {
    const tx = db.transaction([STORE_TOOL_RUNS, STORE_TOOL_RUN_BLOBS], 'readwrite')
    const runs = tx.objectStore(STORE_TOOL_RUNS)
    const drafts = tx.objectStore(STORE_TOOL_RUN_BLOBS)
    const reads = candidates.map(({ run, draft }) => ({
      expectedRun: run,
      expectedDraft: draft,
      runRequest: runs.get(run.id),
      draftRequest: drafts.get(run.id),
      runRead: false,
      draftRead: false,
    }))
    const expiredRuns: OpenShopToolLocalRun[] = []
    let writesStarted = false

    const abort = (error: unknown) => {
      try { tx.abort() } catch { /* transaction 已结束 */ }
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const startWrites = () => {
      if (writesStarted || reads.some((read) => !read.runRead || !read.draftRead)) return
      writesStarted = true
      try {
        for (const read of reads) {
          if (!read.runRequest.result && !read.draftRequest.result) continue
          if (!read.runRequest.result) throw new OpenShopPersistenceError('INVALID_DRAFT', '过期 Draft 对应 Run 已丢失')
          const currentRun = decodeOpenShopToolLocalRunShape(read.runRequest.result)
          if (!hasSameOpenShopRunIdentity(currentRun, read.expectedRun)) {
            throw new OpenShopPersistenceError('IDENTITY_CONFLICT', 'TTL cleanup 期间 Run 身份已变化')
          }
          if (!read.draftRequest.result) {
            if (currentRun.status === 'completed') continue
            throw new OpenShopPersistenceError('INVALID_DRAFT', 'TTL cleanup 期间 Draft 已丢失')
          }
          const currentDraft = decodeOpenShopToolOutputDraftShape(read.draftRequest.result)
          if (!hasSameOpenShopDraftRecord(currentDraft, read.expectedDraft)) {
            throw new OpenShopPersistenceError('IDENTITY_CONFLICT', 'TTL cleanup 期间 Draft 身份已变化')
          }
          if (currentDraft.expiresAt > now) continue
          if (currentRun.status === 'completed') {
            throw new OpenShopPersistenceError('INVALID_DRAFT', 'completed Run 不应保留临时 Draft')
          }
          if (!['exported', 'saving'].includes(currentRun.status) || currentRun.blobId !== currentDraft.blobId) {
            throw new OpenShopPersistenceError('INVALID_DRAFT', 'TTL cleanup 发现 Run/Draft 状态不一致')
          }
          const expired = decodeOpenShopToolLocalRunShape({
            ...currentRun,
            status: 'expired',
            saveStatus: 'failed',
            blobId: null,
            error: { code: 'OUTPUT_DRAFT_EXPIRED', message: 'OpenShop 临时导出结果已过期，请重新规划', retryable: false },
            errorStage: 'expiry',
            updatedAt: now,
            completedAt: null,
          })
          expiredRuns.push(expired)
          const runRequest = runs.put(expired)
          const deleteRequest = drafts.delete(currentRun.id)
          runRequest.onerror = () => abort(runRequest.error ?? new Error('TTL cleanup Run 写入失败'))
          deleteRequest.onerror = () => abort(deleteRequest.error ?? new Error('TTL cleanup Draft 删除失败'))
        }
      } catch (error) {
        abort(error)
      }
    }

    reads.forEach((read) => {
      read.runRequest.onsuccess = () => { read.runRead = true; startWrites() }
      read.draftRequest.onsuccess = () => { read.draftRead = true; startWrites() }
      read.runRequest.onerror = () => abort(read.runRequest.error ?? new Error('TTL cleanup Run 读取失败'))
      read.draftRequest.onerror = () => abort(read.draftRequest.error ?? new Error('TTL cleanup Draft 读取失败'))
    })
    tx.oncomplete = () => resolve(expiredRuns)
    tx.onerror = () => reject(tx.error ?? new Error('TTL cleanup transaction 失败'))
    tx.onabort = () => reject(tx.error ?? new Error('TTL cleanup transaction 已中止'))
  }))
}

// ===== Tasks =====

export function getAllTasks(): Promise<TaskRecord[]> {
  return dbTransaction(STORE_TASKS, 'readonly', (s) => s.getAll())
}

export function putTask(task: TaskRecord): Promise<IDBValidKey> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.put(task))
}

export function deleteTask(id: string): Promise<undefined> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.delete(id))
}

export function clearTasks(): Promise<undefined> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.clear())
}

// ===== Images =====

export function getImage(id: string): Promise<StoredImage | undefined> {
  return dbTransaction(STORE_IMAGES, 'readonly', (s) => s.get(id))
}

export function getStoredImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  return dbTransaction(STORE_THUMBNAILS, 'readonly', (s) => s.get(id))
}

export async function getStoredFreshImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  const thumbnail = await getStoredImageThumbnail(id)
  return thumbnail?.thumbnailVersion === THUMBNAIL_VERSION ? thumbnail : undefined
}

export function putImageThumbnail(thumbnail: StoredImageThumbnail): Promise<IDBValidKey> {
  return dbTransaction(STORE_THUMBNAILS, 'readwrite', (s) => s.put(thumbnail))
}

export async function getImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  const existingThumbnail = await getStoredImageThumbnail(id)
  if (existingThumbnail?.thumbnailVersion === THUMBNAIL_VERSION) {
    const image = await getImage(id)
    if (image && (!image.width || !image.height) && existingThumbnail.width && existingThumbnail.height) {
      await putImage({ ...image, width: existingThumbnail.width, height: existingThumbnail.height })
    }
    return existingThumbnail
  }

  const image = await getImage(id)
  if (!image) return undefined
  const legacyImage = image as StoredImage & Partial<StoredImageThumbnail>
  if (legacyImage.thumbnailDataUrl && legacyImage.thumbnailVersion === THUMBNAIL_VERSION) {
    const thumbnail: StoredImageThumbnail = {
      id,
      thumbnailDataUrl: legacyImage.thumbnailDataUrl,
      width: legacyImage.width,
      height: legacyImage.height,
      thumbnailVersion: THUMBNAIL_VERSION,
    }
    await putImageThumbnail(thumbnail)
    if ((!image.width || !image.height) && thumbnail.width && thumbnail.height) {
      await putImage({ ...image, width: thumbnail.width, height: thumbnail.height })
    }
    return thumbnail
  }

  const metadata = await safeCreateImageThumbnail(image.dataUrl)
  if (!metadata.thumbnailDataUrl) return undefined
  const thumbnail: StoredImageThumbnail = {
    id,
    thumbnailDataUrl: metadata.thumbnailDataUrl,
    width: metadata.width,
    height: metadata.height,
    thumbnailVersion: THUMBNAIL_VERSION,
  }
  await putImageThumbnail(thumbnail)
  if (metadata.width && metadata.height && (image.width !== metadata.width || image.height !== metadata.height)) {
    await putImage({ ...image, width: metadata.width, height: metadata.height })
  }
  return thumbnail
}

export function getAllImages(): Promise<StoredImage[]> {
  return dbTransaction(STORE_IMAGES, 'readonly', (s) => s.getAll())
}

export function getAllImageIds(): Promise<string[]> {
  return dbTransaction(STORE_IMAGES, 'readonly', (s) => s.getAllKeys()).then((keys) =>
    keys.map(String),
  )
}

export function putImage(image: StoredImage): Promise<IDBValidKey> {
  return dbTransaction(STORE_IMAGES, 'readwrite', (s) => s.put(image))
}

export function deleteImage(id: string): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_IMAGES, STORE_THUMBNAILS], 'readwrite')
        tx.objectStore(STORE_IMAGES).delete(id)
        tx.objectStore(STORE_THUMBNAILS).delete(id)
        tx.oncomplete = () => resolve(undefined)
        tx.onerror = () => reject(tx.error)
      }),
  )
}

export function clearImages(): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_IMAGES, STORE_THUMBNAILS], 'readwrite')
        tx.objectStore(STORE_IMAGES).clear()
        tx.objectStore(STORE_THUMBNAILS).clear()
        tx.oncomplete = () => resolve(undefined)
        tx.onerror = () => reject(tx.error)
      }),
  )
}

// ===== Image hashing & dedup =====

export async function hashDataUrl(dataUrl: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    return hashDataUrlFallback(dataUrl)
  }
  return sha256Hex(dataUrl)
}

export interface SaveTaskWithImageAtomicOptions {
  dataUrl: string
  source: NonNullable<StoredImage['source']>
  createTask: (imageId: string) => TaskRecord
  signal?: AbortSignal
  timeoutMs?: number
  onCommit?: () => void
  /** Tool Agent 保存时与图片、缩略图、Task 共用同一提交边界。 */
  completeToolRun?: {
    run: OpenShopToolLocalRun
    draft: OpenShopToolOutputDraft
    expectedStatus: 'saving'
  }
}

export interface SaveTaskWithImageAtomicResult {
  imageId: string
  task: TaskRecord
}

function createAbortError(message: string, name: 'AbortError' | 'TimeoutError') {
  return new DOMException(message, name)
}

function remainingTimeout(deadlineAt: number | null) {
  if (deadlineAt === null) return null
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw createAbortError('OpenShop 原子保存超时', 'TimeoutError')
  return Math.max(1, remaining)
}

function waitForAtomicPreparation<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  deadlineAt: number | null,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(createAbortError('OpenShop 原子保存已取消', 'AbortError'))
  const timeoutMs = remainingTimeout(deadlineAt)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = () => {
      if (settled) return false
      settled = true
      if (timer !== null) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      return true
    }
    const onAbort = () => {
      if (finish()) reject(createAbortError('OpenShop 原子保存已取消', 'AbortError'))
    }
    const timer = timeoutMs === null
      ? null
      : globalThis.setTimeout(() => {
        if (finish()) reject(createAbortError('OpenShop 原子保存超时', 'TimeoutError'))
      }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { if (finish()) resolve(value) },
      (error) => { if (finish()) reject(error) },
    )
  })
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalJsonValue(record[key])]),
    )
  }
  return value
}

function hasSameJsonValue(left: unknown, right: unknown) {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right))
}

function validateOpenShopCompletedTaskRecord(
  run: OpenShopToolLocalRun,
  task: TaskRecord,
  imageId: string,
): Error | null {
  const plan = run.planSnapshot
  if (task.id !== run.taskId
    || task.status !== 'done'
    || task.error !== null
    || task.origin !== 'restricted-agent'
    || task.agentRunId !== run.id
    || task.agentLocalRunId !== run.id
    || task.agentPlanId !== run.planId
    || task.agentOriginalRequest !== plan.originalRequest
    || task.agentLocalRunStatus !== 'completed'
    || task.agentLocalSaveStatus !== 'completed'
    || (task.sourceTaskId ?? null) !== run.sourceTaskId
    || task.inputImageIds.length !== 1
    || task.inputImageIds[0] !== run.inputImageId
    || task.outputImages.length !== 1
    || task.outputImages[0] !== imageId
    || task.prompt !== plan.originalRequest
    || !hasSameJsonValue(task.params, run.taskParams)
    || !hasSameJsonValue(task.agentPlanSnapshot, plan)) {
    return new OpenShopPersistenceError('INVALID_RUN', 'OpenShop completed Task 证据与 Run 不一致')
  }
  return null
}

function validateOpenShopAtomicCompletion(
  currentRunValue: unknown,
  completedRun: OpenShopToolLocalRun,
  currentDraftValue: unknown,
  expectedDraft: OpenShopToolOutputDraft,
  expectedStatus: 'saving',
  task: TaskRecord,
  imageId: string,
): Error | null {
  let currentRun: OpenShopToolLocalRun
  let currentDraft: OpenShopToolOutputDraft
  try {
    currentRun = decodeOpenShopToolLocalRunShape(currentRunValue)
    currentDraft = decodeOpenShopToolOutputDraftShape(currentDraftValue)
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  if (!currentRun
    || currentRun.status !== expectedStatus
    || currentRun.saveStatus !== 'saving') {
    return new Error('OpenShop 本地 Run 保存状态已变化')
  }
  if (completedRun.status !== 'completed'
    || completedRun.saveStatus !== 'completed'
    || !hasSameOpenShopRunIdentity(currentRun, completedRun)) {
    return new Error('OpenShop completed Run 不可变身份与 durable Run 不一致')
  }

  const expectedIdempotencyKey = `openshop:${completedRun.planId}:${completedRun.planVersion}:${completedRun.composerSnapshotHash}`
  const plan = completedRun.planSnapshot
  const operation = plan.operation
  if (completedRun.id !== expectedIdempotencyKey
    || completedRun.idempotencyKey !== expectedIdempotencyKey
    || plan.id !== completedRun.planId
    || plan.version !== completedRun.planVersion
    || plan.composerSnapshotHash !== completedRun.composerSnapshotHash
    || operation.type !== 'openshop.edit'
    || completedRun.outputFormat !== operation.outputFormat
    || !hasSameJsonValue(completedRun.commands, operation.commands)) {
    return new Error('OpenShop completed Run 的 Plan 或 operation 快照不一致')
  }

  if (!currentDraft
    || currentDraft.runId !== currentRun.id
    || expectedDraft.runId !== currentRun.id
    || currentDraft.expiresAt <= Date.now()
    || currentRun.blobId !== currentDraft.blobId
    || !hasSameOpenShopDraftRecord(currentDraft, expectedDraft)) {
    return new Error('OpenShop 临时导出物与保存请求不一致')
  }

  return validateOpenShopCompletedTaskRecord(completedRun, task, imageId)
}

/**
 * 将 OpenShop 输出图片、缩略图和完成态 Task 放在同一个 IndexedDB transaction。
 * hash 与缩略图在 transaction 前生成；任何准备、request、abort 或 timeout 失败都不会留下部分写入。
 */
export async function saveTaskWithImageAtomic(
  options: SaveTaskWithImageAtomicOptions,
): Promise<SaveTaskWithImageAtomicResult> {
  const deadlineAt = options.timeoutMs === undefined
    ? null
    : Date.now() + Math.max(0, options.timeoutMs)
  if (options.signal?.aborted) throw createAbortError('OpenShop 原子保存已取消', 'AbortError')

  const verifiedCompleteToolRun = options.completeToolRun
    ? {
        ...options.completeToolRun,
        run: await waitForAtomicPreparation(
          decodeOpenShopToolLocalRun(options.completeToolRun.run),
          options.signal,
          deadlineAt,
        ),
        draft: await waitForAtomicPreparation(
          decodeOpenShopToolOutputDraft(options.completeToolRun.draft),
          options.signal,
          deadlineAt,
        ),
      }
    : undefined

  const imageId = await waitForAtomicPreparation(hashDataUrl(options.dataUrl), options.signal, deadlineAt)
  const thumbnail = await waitForAtomicPreparation(createImageThumbnail(options.dataUrl), options.signal, deadlineAt)
  const task = options.createTask(imageId)
  if (!task || typeof task !== 'object' || !task.id) throw new Error('OpenShop 原子保存未生成有效 Task')
  if (!task.outputImages.includes(imageId)) throw new Error('OpenShop Task 未引用原子保存的图片')
  const openController = new AbortController()
  const onOpenAbort = () => openController.abort(
    options.signal?.reason instanceof Error
      ? options.signal.reason
      : createAbortError('OpenShop 原子保存已取消', 'AbortError'),
  )
  const openTimeoutMs = remainingTimeout(deadlineAt)
  const openTimer = openTimeoutMs === null
    ? null
    : globalThis.setTimeout(
        () => openController.abort(createAbortError('OpenShop 原子保存超时', 'TimeoutError')),
        openTimeoutMs,
      )
  options.signal?.addEventListener('abort', onOpenAbort, { once: true })
  if (options.signal?.aborted) onOpenAbort()
  let db: IDBDatabase
  try {
    db = await openDB(openController.signal)
  } finally {
    if (openTimer !== null) clearTimeout(openTimer)
    options.signal?.removeEventListener('abort', onOpenAbort)
  }
  const transactionTimeoutMs = remainingTimeout(deadlineAt)

  return new Promise<SaveTaskWithImageAtomicResult>((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(
        verifiedCompleteToolRun
          ? [STORE_IMAGES, STORE_THUMBNAILS, STORE_TASKS, STORE_TOOL_RUNS, STORE_TOOL_RUN_BLOBS]
          : [STORE_IMAGES, STORE_THUMBNAILS, STORE_TASKS],
        'readwrite',
      )
    } catch (error) {
      reject(error)
      return
    }

    let settled = false
    let committed = false
    let imageRequest: IDBRequest<StoredImage | undefined> | null = null
    let thumbnailRequest: IDBRequest<StoredImageThumbnail | undefined> | null = null
    let toolRunRequest: IDBRequest<unknown> | null = null
    let toolDraftRequest: IDBRequest<unknown> | null = null
    let imageRead = false
    let thumbnailRead = false
    let toolRunRead = !verifiedCompleteToolRun
    let toolDraftRead = !verifiedCompleteToolRun
    let writesStarted = false

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: unknown) => {
      if (settled || committed) return
      settled = true
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const abortTransaction = (error: Error) => {
      if (settled || committed) return
      try {
        tx.abort()
      } catch {
        fail(error)
        return
      }
      fail(error)
    }
    const onAbort = () => abortTransaction(createAbortError('OpenShop 原子保存已取消', 'AbortError'))
    const timer = transactionTimeoutMs === null
      ? null
      : globalThis.setTimeout(
        () => abortTransaction(createAbortError('OpenShop 原子保存超时', 'TimeoutError')),
        transactionTimeoutMs,
      )

    const abortOnRequestError = (request: IDBRequest) => {
      abortTransaction(request.error ?? new Error('OpenShop 原子保存 request 失败'))
    }
    const startWrites = () => {
      if (writesStarted || !imageRead || !thumbnailRead || !toolRunRead || !toolDraftRead || settled || committed) return
      writesStarted = true
      const images = tx.objectStore(STORE_IMAGES)
      const thumbnails = tx.objectStore(STORE_THUMBNAILS)
      const tasks = tx.objectStore(STORE_TASKS)
      if (verifiedCompleteToolRun) {
        const currentRun = toolRunRequest?.result
        const draft = toolDraftRequest?.result
        const validationError = validateOpenShopAtomicCompletion(
          currentRun,
          verifiedCompleteToolRun.run,
          draft,
          verifiedCompleteToolRun.draft,
          verifiedCompleteToolRun.expectedStatus,
          task,
          imageId,
        )
        if (validationError) {
          abortTransaction(validationError)
          return
        }
      }
      if (!imageRequest?.result) {
        const request = images.put({
          id: imageId,
          dataUrl: options.dataUrl,
          createdAt: Date.now(),
          source: options.source,
          width: thumbnail.width,
          height: thumbnail.height,
        } satisfies StoredImage)
        request.onerror = () => abortOnRequestError(request)
      }
      if (thumbnailRequest?.result?.thumbnailVersion !== THUMBNAIL_VERSION) {
        const request = thumbnails.put({
          id: imageId,
          thumbnailDataUrl: thumbnail.thumbnailDataUrl,
          width: thumbnail.width,
          height: thumbnail.height,
          thumbnailVersion: THUMBNAIL_VERSION,
        } satisfies StoredImageThumbnail)
        request.onerror = () => abortOnRequestError(request)
      }
      const taskRequest = tasks.put(task)
      taskRequest.onerror = () => abortOnRequestError(taskRequest)
      if (verifiedCompleteToolRun) {
        const runRequest = tx.objectStore(STORE_TOOL_RUNS).put(verifiedCompleteToolRun.run)
        const draftDeleteRequest = tx.objectStore(STORE_TOOL_RUN_BLOBS).delete(verifiedCompleteToolRun.run.id)
        runRequest.onerror = () => abortOnRequestError(runRequest)
        draftDeleteRequest.onerror = () => abortOnRequestError(draftDeleteRequest)
      }
    }

    try {
      const images = tx.objectStore(STORE_IMAGES)
      const thumbnails = tx.objectStore(STORE_THUMBNAILS)
      imageRequest = images.get(imageId)
      thumbnailRequest = thumbnails.get(imageId)
      imageRequest.onsuccess = () => {
        imageRead = true
        startWrites()
      }
      thumbnailRequest.onsuccess = () => {
        thumbnailRead = true
        startWrites()
      }
      imageRequest.onerror = () => abortOnRequestError(imageRequest as IDBRequest)
      thumbnailRequest.onerror = () => abortOnRequestError(thumbnailRequest as IDBRequest)
      if (verifiedCompleteToolRun) {
        toolRunRequest = tx.objectStore(STORE_TOOL_RUNS).get(verifiedCompleteToolRun.run.id)
        toolDraftRequest = tx.objectStore(STORE_TOOL_RUN_BLOBS).get(verifiedCompleteToolRun.run.id)
        toolRunRequest.onsuccess = () => {
          toolRunRead = true
          startWrites()
        }
        toolDraftRequest.onsuccess = () => {
          toolDraftRead = true
          startWrites()
        }
        toolRunRequest.onerror = () => abortOnRequestError(toolRunRequest as IDBRequest)
        toolDraftRequest.onerror = () => abortOnRequestError(toolDraftRequest as IDBRequest)
      }
    } catch (error) {
      abortTransaction(error instanceof Error ? error : new Error(String(error)))
      return
    }

    tx.oncomplete = () => {
      if (settled) return
      committed = true
      settled = true
      cleanup()
      options.onCommit?.()
      resolve({ imageId, task })
    }
    tx.onerror = () => fail(tx.error ?? new Error('OpenShop 原子保存 transaction 失败'))
    tx.onabort = () => fail(tx.error ?? new Error('OpenShop 原子保存 transaction 已中止'))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
  })
}

function hashDataUrlFallback(dataUrl: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193

  for (let i = 0; i < dataUrl.length; i++) {
    const code = dataUrl.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= code
    h2 = Math.imul(h2, 0x27d4eb2d)
  }

  return `fallback-${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * 存储图片，若已存在（按 hash 去重）则跳过。
 * 返回 image id。
 */
export async function storeImage(dataUrl: string, source: NonNullable<StoredImage['source']> = 'upload'): Promise<string> {
  const id = await hashDataUrl(dataUrl)
  const existing = await getImage(id)
  if (!existing) {
    const thumbnail = await safeCreateImageThumbnail(dataUrl)
    await putImage({
      id,
      dataUrl,
      createdAt: Date.now(),
      source,
      width: thumbnail.width,
      height: thumbnail.height,
    })
    if (thumbnail.thumbnailDataUrl) {
      await putImageThumbnail({
        id,
        thumbnailDataUrl: thumbnail.thumbnailDataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
        thumbnailVersion: THUMBNAIL_VERSION,
      })
    }
  } else if ((await getStoredImageThumbnail(id))?.thumbnailVersion !== THUMBNAIL_VERSION) {
    const thumbnail = await safeCreateImageThumbnail(existing.dataUrl)
    if (thumbnail.width && thumbnail.height && (existing.width !== thumbnail.width || existing.height !== thumbnail.height)) {
      await putImage({ ...existing, width: thumbnail.width, height: thumbnail.height })
    }
    if (thumbnail.thumbnailDataUrl) {
      await putImageThumbnail({
        id,
        thumbnailDataUrl: thumbnail.thumbnailDataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
        thumbnailVersion: THUMBNAIL_VERSION,
      })
    }
  }
  return id
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = dataUrl
  })
}

async function createImageThumbnail(dataUrl: string): Promise<Omit<StoredImageThumbnail, 'id'>> {
  const image = await loadImage(dataUrl)
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (width <= 0 || height <= 0) throw new Error('图片尺寸无效')

  const scale = Math.min(1, THUMBNAIL_MAX_SIZE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

  return {
    thumbnailDataUrl: canvas.toDataURL('image/webp', THUMBNAIL_QUALITY),
    width,
    height,
    thumbnailVersion: THUMBNAIL_VERSION,
  }
}

async function safeCreateImageThumbnail(dataUrl: string): Promise<Partial<Omit<StoredImageThumbnail, 'id'>>> {
  try {
    return await createImageThumbnail(dataUrl)
  } catch {
    return {}
  }
}

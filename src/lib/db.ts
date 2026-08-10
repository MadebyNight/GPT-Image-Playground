import type { TaskRecord, StoredImage, StoredImageThumbnail } from '../types'

const DB_NAME = 'gpt-image-playground'
const DB_VERSION = 2
const STORE_TASKS = 'tasks'
const STORE_IMAGES = 'images'
const STORE_THUMBNAILS = 'thumbnails'
const THUMBNAIL_MAX_SIZE = 720
const THUMBNAIL_QUALITY = 0.9
const THUMBNAIL_VERSION = 2

export const CURRENT_THUMBNAIL_VERSION = THUMBNAIL_VERSION

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
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
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
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

  const data = new TextEncoder().encode(dataUrl)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface SaveTaskWithImageAtomicOptions {
  dataUrl: string
  source: NonNullable<StoredImage['source']>
  createTask: (imageId: string) => TaskRecord
  signal?: AbortSignal
  timeoutMs?: number
  onCommit?: () => void
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

  const imageId = await waitForAtomicPreparation(hashDataUrl(options.dataUrl), options.signal, deadlineAt)
  const thumbnail = await waitForAtomicPreparation(createImageThumbnail(options.dataUrl), options.signal, deadlineAt)
  const task = options.createTask(imageId)
  if (!task || typeof task !== 'object' || !task.id) throw new Error('OpenShop 原子保存未生成有效 Task')
  if (!task.outputImages.includes(imageId)) throw new Error('OpenShop Task 未引用原子保存的图片')

  const db = await waitForAtomicPreparation(openDB(), options.signal, deadlineAt)
  const transactionTimeoutMs = remainingTimeout(deadlineAt)

  return new Promise<SaveTaskWithImageAtomicResult>((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction([STORE_IMAGES, STORE_THUMBNAILS, STORE_TASKS], 'readwrite')
    } catch (error) {
      reject(error)
      return
    }

    let settled = false
    let committed = false
    let imageRequest: IDBRequest<StoredImage | undefined> | null = null
    let thumbnailRequest: IDBRequest<StoredImageThumbnail | undefined> | null = null
    let imageRead = false
    let thumbnailRead = false
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
      if (writesStarted || !imageRead || !thumbnailRead || settled || committed) return
      writesStarted = true
      const images = tx.objectStore(STORE_IMAGES)
      const thumbnails = tx.objectStore(STORE_THUMBNAILS)
      const tasks = tx.objectStore(STORE_TASKS)
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

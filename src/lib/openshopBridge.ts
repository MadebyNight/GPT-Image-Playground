export const OPENSHOP_PROTOCOL_VERSION = 1

export type OpenShopExportFormat = 'png'

export interface OpenShopDocument {
  blob: Blob
  name: string
}

export interface OpenShopMessage {
  version: number
  type: string
  id?: string | null
  [key: string]: unknown
}

export interface OpenShopExportedMessage extends OpenShopMessage {
  type: 'openshop:exported'
  blob: Blob
  filename: string
  format: OpenShopExportFormat
}

export interface OpenShopSaveRequestedMessage extends OpenShopMessage {
  type: 'openshop:save-requested'
  blob: Blob
  filename: string
}

export function getOpenShopFrameUrl(pageUrl = window.location.href): string {
  return new URL('openshop/index.html', pageUrl).toString()
}

export function getOpenShopTargetOrigin(frameUrl: string): string {
  return new URL(frameUrl).origin
}

export function isOpenShopMessage(value: unknown): value is OpenShopMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return typeof message.type === 'string'
    && message.type.startsWith('openshop:')
    && Number(message.version) === OPENSHOP_PROTOCOL_VERSION
}

export function isOpenShopMessageFromFrame(
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  frameWindow: Window | null,
  targetOrigin: string,
): event is Pick<MessageEvent, 'origin' | 'source'> & { data: OpenShopMessage } {
  return event.source === frameWindow
    && event.origin === targetOrigin
    && isOpenShopMessage(event.data)
}

/**
 * 回复必须关联到一个仍在等待的、非空请求 ID。
 *
 * 不能把 expectedId 为 null 与没有 ID 的回复视为匹配，否则迟到或无关联的
 * postMessage 会被宿主误认为当前请求的完成信号。
 */
export function isOpenShopRequestIdMatch(expectedId: string | null | undefined, responseId: unknown): boolean {
  return typeof expectedId === 'string' && expectedId.length > 0 && responseId === expectedId
}

export function createOpenShopRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function postOpenShopMessage(
  frameWindow: Window,
  targetOrigin: string,
  message: Omit<OpenShopMessage, 'version'>,
) {
  frameWindow.postMessage({ version: OPENSHOP_PROTOCOL_VERSION, ...message }, targetOrigin)
}

export async function dataUrlToOpenShopDocument(dataUrl: string, name: string): Promise<OpenShopDocument> {
  const response = await fetch(dataUrl)
  if (!response.ok) throw new Error(`无法读取待编辑图片：HTTP ${response.status}`)
  const blob = await response.blob()
  if (!blob.size) throw new Error('待编辑图片为空')
  return {
    blob: blob.type ? blob : new Blob([await blob.arrayBuffer()], { type: 'image/png' }),
    name,
  }
}

export const OPENSHOP_PROTOCOL_VERSION = 1

export type OpenShopExportFormat = 'png' | 'jpeg' | 'webp' | 'avif' | 'svg' | 'pdf'

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

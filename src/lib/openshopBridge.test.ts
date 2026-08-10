import { describe, expect, it } from 'vitest'
import {
  OPENSHOP_PROTOCOL_VERSION,
  OPENSHOP_TOOL_MAX_COMMANDS,
  createOpenShopRequestId,
  getOpenShopFrameUrl,
  getOpenShopTargetOrigin,
  hasExpectedImageMagic,
  isOpenShopMessage,
  isOpenShopMessageFromFrame,
  isOpenShopRequestIdMatch,
  isOpenShopToolMessage,
  isOpenShopToolMessageFromFrame,
  isOpenShopToolRequestMessage,
  isOpenShopToolResponseMessage,
  normalizeOpenShopToolCommands,
} from './openshopBridge'

describe('OpenShop bridge protocol', () => {
  it('resolves the static editor relative to the application path', () => {
    const frameUrl = getOpenShopFrameUrl('https://example.test/image-playground/#/openshop/image-1')

    expect(frameUrl).toBe('https://example.test/image-playground/openshop/index.html')
    expect(getOpenShopTargetOrigin(frameUrl)).toBe('https://example.test')
  })

  it('accepts only the supported protocol messages', () => {
    expect(isOpenShopMessage({ version: OPENSHOP_PROTOCOL_VERSION, type: 'openshop:ready' })).toBe(true)
    expect(isOpenShopMessage({ version: '1', type: 'openshop:ready' })).toBe(false)
    expect(isOpenShopMessage({ version: 2, type: 'openshop:ready' })).toBe(false)
    expect(isOpenShopMessage({ version: OPENSHOP_PROTOCOL_VERSION, type: 'other:ready' })).toBe(false)
  })

  it('requires both the editor frame window and exact origin', () => {
    const frameWindow = {} as Window
    const message = { version: OPENSHOP_PROTOCOL_VERSION, type: 'openshop:ready' }

    expect(isOpenShopMessageFromFrame({ origin: 'https://editor.example.test', source: frameWindow, data: message }, frameWindow, 'https://editor.example.test')).toBe(true)
    expect(isOpenShopMessageFromFrame({ origin: 'https://other.example.test', source: frameWindow, data: message }, frameWindow, 'https://editor.example.test')).toBe(false)
    expect(isOpenShopMessageFromFrame({ origin: 'https://editor.example.test', source: {} as Window, data: message }, frameWindow, 'https://editor.example.test')).toBe(false)
  })

  it('accepts tool replies only from the exact frame, origin, version, and nonempty request id', () => {
    const frameWindow = {} as Window
    const message = {
      version: 1,
      type: 'openshop:tool:ready',
      id: 'hello-1',
      requestId: 'hello-1',
      sessionId: 'session-1',
      capabilities: {
        commands: ['canvas.crop', 'canvas.rotate', 'canvas.flip', 'canvas.flatten'],
        maxCommands: 5,
        inputMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
        outputFormats: ['png'],
      },
    }

    expect(isOpenShopToolMessage(message)).toBe(true)
    expect(isOpenShopToolResponseMessage(message)).toBe(true)
    expect(isOpenShopToolMessage({ ...message, version: '1' })).toBe(false)
    expect(isOpenShopToolMessage({ ...message, version: 2 })).toBe(false)
    expect(isOpenShopToolMessage({ ...message, id: '' })).toBe(false)
    expect(isOpenShopToolMessage({ ...message, requestId: '' })).toBe(false)
    expect(isOpenShopToolMessage({ ...message, requestId: 'other-id' })).toBe(false)
    expect(isOpenShopToolMessage({ ...message, sessionId: '' })).toBe(false)
    expect(isOpenShopToolMessage({ ...message, unknown: true })).toBe(false)
    expect(isOpenShopToolMessageFromFrame(
      { origin: 'https://editor.example.test', source: frameWindow, data: message },
      frameWindow,
      'https://editor.example.test',
    )).toBe(true)
    expect(isOpenShopToolMessageFromFrame(
      { origin: 'https://other.example.test', source: frameWindow, data: message },
      frameWindow,
      'https://editor.example.test',
    )).toBe(false)
    expect(isOpenShopToolMessageFromFrame(
      { origin: 'https://editor.example.test', source: {} as Window, data: message },
      frameWindow,
      'https://editor.example.test',
    )).toBe(false)
  })

  it('requires exact request and response fields for every tool message', () => {
    const base = { version: 1, id: 'request-1', requestId: 'request-1', sessionId: 'session-1' }
    const descriptor = { canvas: { width: 10, height: 20 }, primaryImage: { present: true } }

    expect(isOpenShopToolRequestMessage({ ...base, type: 'openshop:tool:hello' })).toBe(true)
    expect(isOpenShopToolRequestMessage({ ...base, type: 'openshop:tool:hello', extra: true })).toBe(false)
    expect(isOpenShopToolRequestMessage({
      ...base,
      type: 'openshop:tool:configure',
      document: { blob: new Blob([new Uint8Array([1])], { type: 'image/png' }), name: 'source.png' },
    })).toBe(true)
    expect(isOpenShopToolRequestMessage({ ...base, type: 'openshop:tool:export', format: 'png' })).toBe(true)
    expect(isOpenShopToolRequestMessage({ ...base, type: 'openshop:tool:export', format: 'webp' })).toBe(false)

    expect(isOpenShopToolResponseMessage({ ...base, type: 'openshop:tool:configured', document: descriptor })).toBe(true)
    expect(isOpenShopToolResponseMessage({ ...base, type: 'openshop:tool:configured', document: { ...descriptor, extra: true } })).toBe(false)
    expect(isOpenShopToolResponseMessage({
      ...base,
      type: 'openshop:tool:error',
      code: 'VALIDATION_FAILED',
      message: 'bad command',
      retryable: false,
      commandIndex: 0,
    })).toBe(true)
    expect(isOpenShopToolResponseMessage({
      ...base,
      type: 'openshop:tool:error',
      code: 'NOT_REAL',
      message: 'bad command',
      retryable: false,
    })).toBe(false)
  })

  it('matches replies only to a nonempty pending request id', () => {
    expect(isOpenShopRequestIdMatch('configure-1', 'configure-1')).toBe(true)
    expect(isOpenShopRequestIdMatch('configure-1', 'configure-2')).toBe(false)
    expect(isOpenShopRequestIdMatch('configure-1', null)).toBe(false)
    expect(isOpenShopRequestIdMatch('', '')).toBe(false)
    expect(isOpenShopRequestIdMatch(null, null)).toBe(false)
    expect(isOpenShopRequestIdMatch(undefined, undefined)).toBe(false)
  })

  it('creates request IDs with a caller-owned scope', () => {
    expect(createOpenShopRequestId('hello')).toMatch(/^hello-\d+-[a-z0-9]+$/)
    expect(createOpenShopRequestId('configure')).toMatch(/^configure-\d+-[a-z0-9]+$/)
  })

  it('normalizes only the four deterministic document commands', () => {
    expect(normalizeOpenShopToolCommands([
      { schemaVersion: 1, id: 'canvas.crop', target: 'document', args: { x: 0, y: 1, width: 20, height: 10 } },
      { schemaVersion: 1, id: 'canvas.rotate', target: 'document', args: { degrees: 90 } },
      { schemaVersion: 1, id: 'canvas.flip', target: 'document', args: { axis: 'h' } },
      { schemaVersion: 1, id: 'canvas.flatten', target: 'document', args: {} },
    ])).toEqual([
      { schemaVersion: 1, id: 'canvas.crop', target: 'document', args: { x: 0, y: 1, width: 20, height: 10 } },
      { schemaVersion: 1, id: 'canvas.rotate', target: 'document', args: { degrees: 90 } },
      { schemaVersion: 1, id: 'canvas.flip', target: 'document', args: { axis: 'h' } },
      { schemaVersion: 1, id: 'canvas.flatten', target: 'document', args: {} },
    ])
  })

  it('rejects unknown commands, runtime ids, unsafe crop parameters, and oversized batches', () => {
    expect(() => normalizeOpenShopToolCommands([])).toThrow('1 到 5 条命令')
    expect(() => normalizeOpenShopToolCommands([
      { schemaVersion: 1, id: 'object.rotate', target: 'document', args: { objectId: 'random', degrees: 90 } },
    ])).toThrow('不在 OpenShop MVP 白名单')
    expect(() => normalizeOpenShopToolCommands([
      { schemaVersion: 1, id: 'canvas.crop', target: 'primary-image', args: { x: 0, y: 0, width: 1, height: 1 } },
    ])).toThrow('格式无效')
    expect(() => normalizeOpenShopToolCommands([
      { schemaVersion: 1, id: 'canvas.crop', target: 'document', args: { x: -1, y: 0, width: 1, height: 1 } },
    ])).toThrow('裁剪 x')
    expect(() => normalizeOpenShopToolCommands([
      { schemaVersion: 1, id: 'canvas.crop', target: 'document', args: { x: 0, y: 0, width: 10_000, height: 10_000 } },
    ])).toThrow('8000 万像素')
    expect(() => normalizeOpenShopToolCommands([
      { schemaVersion: 1, id: 'canvas.crop', target: 'document', args: { x: 0.5, y: 0, width: 1, height: 1 } },
    ])).toThrow('裁剪 x')
    expect(() => normalizeOpenShopToolCommands([
      { schemaVersion: 1, id: 'canvas.rotate', target: 'document', args: { degrees: 45 } },
    ])).toThrow('仅支持 ±90 或 ±180')
    expect(() => normalizeOpenShopToolCommands([
      { schemaVersion: '1', id: 'canvas.rotate', target: 'document', args: { degrees: 90 } },
    ])).toThrow('格式无效')
    expect(() => normalizeOpenShopToolCommands([
      { schemaVersion: 1, id: 'canvas.rotate', target: 'document', args: { degrees: '90' } },
    ])).toThrow('仅支持 ±90 或 ±180')
    expect(() => normalizeOpenShopToolCommands([
      { schemaVersion: 1, id: 'canvas.rotate', target: 'document' },
    ])).toThrow('格式无效')
    expect(() => normalizeOpenShopToolCommands([
      { schemaVersion: 1, id: 'canvas.rotate', target: 'document', args: [] },
    ])).toThrow('格式无效')
    expect(() => normalizeOpenShopToolCommands([
      { schemaVersion: 1, id: 'canvas.flip', target: 'document', args: { axis: 'diagonal' } },
    ])).toThrow('仅支持 h 或 v')
    expect(() => normalizeOpenShopToolCommands([
      { schemaVersion: 1, id: 'canvas.flatten', target: 'document', args: { objectId: 'forbidden' } },
    ])).toThrow('不接受参数')
    expect(() => normalizeOpenShopToolCommands(Array.from({ length: OPENSHOP_TOOL_MAX_COMMANDS + 1 }, () => ({
      schemaVersion: 1,
      id: 'canvas.flatten',
      target: 'document',
      args: {},
    })))).toThrow('1 到 5 条命令')
  })

  it('checks PNG, JPEG, and WebP magic bytes against the declared MIME type', () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const webp = new TextEncoder().encode('RIFF1234WEBP')

    expect(hasExpectedImageMagic('image/png', png)).toBe(true)
    expect(hasExpectedImageMagic('image/jpeg', jpeg)).toBe(true)
    expect(hasExpectedImageMagic('image/webp', webp)).toBe(true)
    expect(hasExpectedImageMagic('image/png', jpeg)).toBe(false)
    expect(hasExpectedImageMagic('image/jpeg', png)).toBe(false)
    expect(hasExpectedImageMagic('image/webp', new TextEncoder().encode('RIFF1234NOPE'))).toBe(false)
  })
})

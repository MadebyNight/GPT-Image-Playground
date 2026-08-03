import { describe, expect, it } from 'vitest'
import {
  OPENSHOP_PROTOCOL_VERSION,
  getOpenShopFrameUrl,
  getOpenShopTargetOrigin,
  isOpenShopMessage,
  isOpenShopMessageFromFrame,
} from './openshopBridge'

describe('OpenShop bridge protocol', () => {
  it('resolves the static editor relative to the application path', () => {
    const frameUrl = getOpenShopFrameUrl('https://example.test/image-playground/#/openshop/image-1')

    expect(frameUrl).toBe('https://example.test/image-playground/openshop/index.html')
    expect(getOpenShopTargetOrigin(frameUrl)).toBe('https://example.test')
  })

  it('accepts only the supported protocol messages', () => {
    expect(isOpenShopMessage({ version: OPENSHOP_PROTOCOL_VERSION, type: 'openshop:ready' })).toBe(true)
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
})

import { describe, expect, it } from 'vitest'
import { getOpenShopHash, getOpenShopRoute } from './openshopRoute'

describe('OpenShop route', () => {
  it('serializes a route with source task provenance', () => {
    const hash = getOpenShopHash('image/a', 'task 1')

    expect(hash).toBe('/openshop/image%2Fa?task=task+1')
    expect(getOpenShopRoute(`#${hash}`)).toEqual({ imageId: 'image/a', taskId: 'task 1' })
  })

  it('rejects unrelated and malformed routes', () => {
    expect(getOpenShopRoute('#/gallery')).toBeNull()
    expect(getOpenShopRoute('#/openshop/%E0%A4%A')).toBeNull()
  })
})

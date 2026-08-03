export interface OpenShopRoute {
  imageId: string
  taskId: string | null
}

const OPENSHOP_ROUTE_PREFIX = '/openshop/'

export function getOpenShopRoute(hash: string): OpenShopRoute | null {
  const normalizedHash = hash.startsWith('#') ? hash.slice(1) : hash
  if (!normalizedHash.startsWith(OPENSHOP_ROUTE_PREFIX)) return null

  const [path, search = ''] = normalizedHash.split('?', 2)
  const encodedImageId = path.slice(OPENSHOP_ROUTE_PREFIX.length)
  if (!encodedImageId) return null

  try {
    return {
      imageId: decodeURIComponent(encodedImageId),
      taskId: new URLSearchParams(search).get('task'),
    }
  } catch {
    return null
  }
}

export function getOpenShopHash(imageId: string, taskId?: string | null): string {
  const params = new URLSearchParams()
  if (taskId) params.set('task', taskId)
  const search = params.size ? `?${params.toString()}` : ''
  return `${OPENSHOP_ROUTE_PREFIX}${encodeURIComponent(imageId)}${search}`
}

import { vi } from 'vitest'
import type { ImageExecutor } from '../src/executor.js'
import type { Planner } from '../src/planner.js'

export const RESTRICTED_PLAN_RESPONSE_FIXTURE = {
  schemaVersion: 2,
  id: '<plan-id>',
  version: 1,
  status: 'awaiting_confirmation',
  expiresAt: '<expires-at>',
  originalRequest: '生成一张红色图片',
  composerSnapshotHash: '<composer-snapshot-hash>',
  summary: '生成一张测试图片',
  operation: {
    type: 'image.generate',
    generation: {
      exactPrompt: '一张红色测试图片',
      action: 'generate',
      size: '1024x1024',
      quality: 'medium',
      outputFormat: 'png',
      outputCompression: null,
      imageCount: 1,
    },
  },
  inputs: [],
  assumptions: [],
  warnings: [],
  policyVersion: 'tool-operation-v2',
} as const

export const RESTRICTED_EXECUTION_RESPONSE_FIXTURE = {
  id: '<execution-id>',
  planId: '<plan-id>',
  status: 'completed',
  cancelRequested: false,
  error: null,
  outputAssets: [{
    id: '<asset-id>',
    url: '/agent-api/v1/assets/<asset-id>',
    mimeType: 'image/png',
    sha256: '93457dce71e2522fbf1dfaf113ef0cc57b611745aabf629ca5daaccab2741b48',
    width: 2,
    height: 2,
    byteSize: 95,
  }],
  createdAt: '<created-at>',
  startedAt: '<started-at>',
  completedAt: '<completed-at>',
  updatedAt: '<updated-at>',
} as const

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function normalizeUuid(value: unknown, placeholder: string): unknown {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? placeholder : value
}

function normalizeIsoTimestamp(value: unknown, placeholder: string): unknown {
  if (typeof value !== 'string') return value
  const timestamp = new Date(value)
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value ? placeholder : value
}

export function normalizeRestrictedPlanResponse(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const plan = value as Record<string, unknown>
  return {
    ...plan,
    id: normalizeUuid(plan.id, '<plan-id>'),
    expiresAt: normalizeIsoTimestamp(plan.expiresAt, '<expires-at>'),
    composerSnapshotHash: typeof plan.composerSnapshotHash === 'string' && /^[a-f0-9]{64}$/.test(plan.composerSnapshotHash)
      ? '<composer-snapshot-hash>'
      : plan.composerSnapshotHash,
  }
}

export function normalizeRestrictedExecutionResponse(value: unknown, expectedPlanId: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const execution = value as Record<string, unknown>
  const outputAssets = Array.isArray(execution.outputAssets)
    ? execution.outputAssets.map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value
        const asset = value as Record<string, unknown>
        const assetId = asset.id
        return {
          ...asset,
          id: normalizeUuid(assetId, '<asset-id>'),
          url: typeof assetId === 'string' && asset.url === `/agent-api/v1/assets/${assetId}`
            ? '/agent-api/v1/assets/<asset-id>'
            : asset.url,
        }
      })
    : execution.outputAssets
  return {
    ...execution,
    id: normalizeUuid(execution.id, '<execution-id>'),
    planId: execution.planId === expectedPlanId ? '<plan-id>' : execution.planId,
    outputAssets,
    createdAt: normalizeIsoTimestamp(execution.createdAt, '<created-at>'),
    startedAt: normalizeIsoTimestamp(execution.startedAt, '<started-at>'),
    completedAt: normalizeIsoTimestamp(execution.completedAt, '<completed-at>'),
    updatedAt: normalizeIsoTimestamp(execution.updatedAt, '<updated-at>'),
  }
}

export function createDeterministicPlannerFixture(action: 'generate' | 'edit' | 'openshop.edit' = 'generate'): Planner {
  return {
    createDraft: vi.fn(async () => ({
      summary: action === 'openshop.edit' ? '旋转现有图片' : '生成一张测试图片',
      operation: action === 'openshop.edit'
        ? {
            type: 'openshop.edit',
            inputIndex: 0,
            commands: [{ schemaVersion: 1, id: 'canvas.rotate', target: 'document', args: { degrees: 90 } }],
            outputFormat: 'png',
          }
        : {
            type: action === 'generate' ? 'image.generate' : 'image.edit',
            generation: {
              exactPrompt: '一张红色测试图片',
              action,
              size: '1024x1024',
              quality: 'medium',
              outputFormat: 'png',
              outputCompression: null,
              imageCount: 1,
            },
          },
      assumptions: [],
      warnings: [],
    })),
  }
}

export function createDeterministicExecutorFixture(
  outputs: Buffer[],
  delayMs = 0,
): ImageExecutor & { execute: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      if (delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs)
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('aborted'))
          }, { once: true })
        })
      }
      return outputs
    }),
  }
}

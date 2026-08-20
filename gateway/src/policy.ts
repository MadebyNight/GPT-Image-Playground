import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GatewayConfig } from './config.js';
import { AppError } from './errors.js';
import { openShopCanvasCommandSchema } from './plan.js';
import type {
  ComposerSnapshotManifest,
  GenerationPlan,
  PlanInputView,
  PlanPreferences,
  PlannerDraft,
} from './types.js';

export const POLICY_VERSION = 'tool-operation-v2';
export const LEGACY_POLICY_VERSION = 'restricted-image-v1';
export const TOOL_PLAN_SCHEMA_VERSION = 2 as const;
export const ALLOWED_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const generationSchema = z.object({
  exactPrompt: z.string().trim().min(1).max(16_000),
  action: z.enum(['generate', 'edit']),
  size: z.enum(ALLOWED_SIZES),
  quality: z.enum(['auto', 'low', 'medium', 'high']),
  outputFormat: z.enum(['png', 'jpeg', 'webp']),
  outputCompression: z.number().int().min(0).max(100).nullable(),
  imageCount: z.number().int().min(1),
}).strict();
const imageGenerateOperationSchema = z.object({
  type: z.literal('image.generate'),
  generation: generationSchema.extend({ action: z.literal('generate') }).strict(),
}).strict();
const imageEditOperationSchema = z.object({
  type: z.literal('image.edit'),
  generation: generationSchema.extend({ action: z.literal('edit') }).strict(),
}).strict();
const openShopDraftOperationSchema = z.object({
  type: z.literal('openshop.edit'),
  inputIndex: z.number().int().min(0),
  commands: z.array(openShopCanvasCommandSchema).min(1).max(5),
  outputFormat: z.literal('png'),
}).strict();

export const plannerDraftSchema = z.object({
  assistantMessage: z.string().trim().min(1).max(240),
  summary: z.string().trim().min(1).max(1000),
  operation: z.discriminatedUnion('type', [
    imageGenerateOperationSchema,
    imageEditOperationSchema,
    openShopDraftOperationSchema,
  ]),
  assumptions: z.array(z.string().trim().min(1).max(500)).max(12),
  warnings: z.array(z.string().trim().min(1).max(500)).max(12),
}).strict();

const composerSnapshotManifestSchema = z.object({
  schemaVersion: z.literal(TOOL_PLAN_SCHEMA_VERSION),
  scope: z.literal('tool'),
  prompt: z.string().max(16_000),
  inputs: z.array(z.object({
    browserImageId: z.string().min(1).max(256),
    contentSha256: sha256Schema,
    role: z.enum(['reference', 'mask_target']),
    ordinal: z.number().int().min(0),
  }).strict()).max(17),
  mask: z.object({
    targetBrowserImageId: z.string().min(1).max(256),
    contentSha256: sha256Schema,
  }).strict().nullable(),
  params: z.object({
    size: z.enum(ALLOWED_SIZES),
    quality: z.enum(['auto', 'low', 'medium', 'high']),
    outputFormat: z.enum(['png', 'jpeg', 'webp']),
    outputCompression: z.number().int().min(0).max(100).nullable(),
    moderation: z.enum(['auto', 'low']),
    imageCount: z.number().int().min(1),
  }).strict(),
  temporaryProfile: z.object({
    id: z.string().min(1).max(256).nullable(),
    name: z.string().min(1).max(500).nullable(),
    missing: z.boolean(),
  }).strict(),
}).strict();

const generationJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['exactPrompt', 'action', 'size', 'quality', 'outputFormat', 'outputCompression', 'imageCount'],
  properties: {
    exactPrompt: { type: 'string', minLength: 1, maxLength: 16000 },
    action: { type: 'string', enum: ['generate', 'edit'] },
    size: { type: 'string', enum: [...ALLOWED_SIZES] },
    quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] },
    outputFormat: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
    outputCompression: { anyOf: [{ type: 'integer', minimum: 0, maximum: 100 }, { type: 'null' }] },
    imageCount: { type: 'integer', minimum: 1 },
  },
} as const;

const commandJsonSchemas = [
  {
    type: 'object', additionalProperties: false,
    required: ['schemaVersion', 'id', 'target', 'args'],
    properties: {
      schemaVersion: { type: 'integer', enum: [1] }, id: { type: 'string', enum: ['canvas.crop'] },
      target: { type: 'string', enum: ['document'] },
      args: {
        type: 'object',
        description: '裁剪矩形；width * height 必须 <= 80_000_000。',
        additionalProperties: false, required: ['x', 'y', 'width', 'height'],
        properties: {
          x: { type: 'integer', minimum: 0, maximum: 30000 },
          y: { type: 'integer', minimum: 0, maximum: 30000 },
          width: { type: 'integer', minimum: 1, maximum: 30000, description: '裁剪宽度；与 height 的乘积不得超过 80_000_000。' },
          height: { type: 'integer', minimum: 1, maximum: 30000, description: '裁剪高度；与 width 的乘积不得超过 80_000_000。' },
        },
      },
    },
  },
  {
    type: 'object', additionalProperties: false,
    required: ['schemaVersion', 'id', 'target', 'args'],
    properties: {
      schemaVersion: { type: 'integer', enum: [1] }, id: { type: 'string', enum: ['canvas.rotate'] },
      target: { type: 'string', enum: ['document'] },
      args: {
        type: 'object', additionalProperties: false, required: ['degrees'],
        properties: { degrees: { type: 'integer', enum: [90, -90, 180, -180] } },
      },
    },
  },
  {
    type: 'object', additionalProperties: false,
    required: ['schemaVersion', 'id', 'target', 'args'],
    properties: {
      schemaVersion: { type: 'integer', enum: [1] }, id: { type: 'string', enum: ['canvas.flip'] },
      target: { type: 'string', enum: ['document'] },
      args: {
        type: 'object', additionalProperties: false, required: ['axis'],
        properties: { axis: { type: 'string', enum: ['h', 'v'] } },
      },
    },
  },
  {
    type: 'object', additionalProperties: false,
    required: ['schemaVersion', 'id', 'target', 'args'],
    properties: {
      schemaVersion: { type: 'integer', enum: [1] }, id: { type: 'string', enum: ['canvas.flatten'] },
      target: { type: 'string', enum: ['document'] },
      args: { type: 'object', additionalProperties: false, required: [], properties: {} },
    },
  },
] as const;

export const plannerJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['assistantMessage', 'summary', 'operation', 'assumptions', 'warnings'],
  properties: {
    assistantMessage: { type: 'string', minLength: 1, maxLength: 240, description: '展示给用户的简短计划说明；不包含 JSON、内部推理或执行细节。' },
    summary: { type: 'string', minLength: 1, maxLength: 1000 },
    operation: {
      anyOf: [
        {
          type: 'object', additionalProperties: false, required: ['type', 'generation'],
          properties: {
            type: { type: 'string', enum: ['image.generate'] },
            generation: { ...generationJsonSchema, properties: { ...generationJsonSchema.properties, action: { type: 'string', enum: ['generate'] } } },
          },
        },
        {
          type: 'object', additionalProperties: false, required: ['type', 'generation'],
          properties: {
            type: { type: 'string', enum: ['image.edit'] },
            generation: { ...generationJsonSchema, properties: { ...generationJsonSchema.properties, action: { type: 'string', enum: ['edit'] } } },
          },
        },
        {
          type: 'object', additionalProperties: false, required: ['type', 'inputIndex', 'commands', 'outputFormat'],
          properties: {
            type: { type: 'string', enum: ['openshop.edit'] },
            inputIndex: { type: 'integer', minimum: 0 },
            commands: { type: 'array', minItems: 1, maxItems: 5, items: { anyOf: commandJsonSchemas } },
            outputFormat: { type: 'string', enum: ['png'] },
          },
        },
      ],
    },
    assumptions: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 500 } },
    warnings: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 500 } },
  },
} as const;

export function parseComposerSnapshotManifest(input: string, config: GatewayConfig): ComposerSnapshotManifest {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new AppError(400, 'invalid_composer_snapshot', 'Composer 快照不是有效 JSON');
  }
  const parsed = composerSnapshotManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, 'invalid_composer_snapshot', 'Composer 快照 schema 无效');
  }
  if (parsed.data.inputs.filter((item) => item.role === 'reference').length > config.maxReferenceImages) {
    throw new AppError(400, 'too_many_references', '参考图数量超过限制');
  }
  const seen = new Set<string>();
  for (const inputItem of parsed.data.inputs) {
    const key = `${inputItem.role}:${inputItem.ordinal}`;
    if (seen.has(key)) throw new AppError(400, 'invalid_composer_snapshot', 'Composer 输入 role + ordinal 重复');
    seen.add(key);
  }
  const maskTargets = parsed.data.inputs.filter((item) => item.role === 'mask_target');
  if (maskTargets.length > 1 || Boolean(parsed.data.mask) !== (maskTargets.length === 1)) {
    throw new AppError(400, 'invalid_mask_inputs', 'mask 与 mask_target 必须同时提供');
  }
  if (parsed.data.mask && maskTargets[0]?.browserImageId !== parsed.data.mask.targetBrowserImageId) {
    throw new AppError(400, 'invalid_mask_inputs', 'mask target 与 Composer 输入不一致');
  }
  if (parsed.data.params.imageCount > config.maxOutputImages) {
    throw new AppError(400, 'invalid_image_count', `输出图片数量必须为 1-${config.maxOutputImages}`);
  }
  return parsed.data as ComposerSnapshotManifest;
}

export function normalizeComposerSnapshot(manifest: ComposerSnapshotManifest): ComposerSnapshotManifest {
  return {
    schemaVersion: TOOL_PLAN_SCHEMA_VERSION,
    scope: 'tool',
    prompt: manifest.prompt.trim(),
    inputs: manifest.inputs.map((item) => ({
      browserImageId: item.browserImageId,
      contentSha256: item.contentSha256,
      role: item.role,
      ordinal: item.ordinal,
    })),
    mask: manifest.mask
      ? {
          targetBrowserImageId: manifest.mask.targetBrowserImageId,
          contentSha256: manifest.mask.contentSha256,
        }
      : null,
    params: {
      size: manifest.params.size,
      quality: manifest.params.quality,
      outputFormat: manifest.params.outputFormat,
      outputCompression: manifest.params.outputFormat === 'png'
        ? null
        : manifest.params.outputCompression ?? 90,
      moderation: manifest.params.moderation,
      imageCount: manifest.params.imageCount,
    },
    temporaryProfile: {
      id: manifest.temporaryProfile.id,
      name: manifest.temporaryProfile.name,
      missing: manifest.temporaryProfile.missing,
    },
  };
}

export function hashComposerSnapshot(manifest: ComposerSnapshotManifest): string {
  const canonical = JSON.stringify(normalizeComposerSnapshot(manifest));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function constrainGeneration(
  generationInput: GenerationPlan,
  preferences: PlanPreferences,
  assets: PlanInputView[],
  config: GatewayConfig,
): GenerationPlan {
  const generation = {
    ...generationInput,
    ...(preferences.size ? { size: preferences.size } : {}),
    ...(preferences.quality ? { quality: preferences.quality } : {}),
    ...(preferences.outputFormat ? { outputFormat: preferences.outputFormat } : {}),
    ...(preferences.outputCompression !== undefined ? { outputCompression: preferences.outputCompression } : {}),
    ...(preferences.imageCount !== undefined ? { imageCount: preferences.imageCount } : {}),
  };
  if (!ALLOWED_SIZES.includes(generation.size as (typeof ALLOWED_SIZES)[number])) {
    throw new AppError(400, 'invalid_size', '不支持的图片尺寸');
  }
  if (generation.imageCount < 1 || generation.imageCount > config.maxOutputImages) {
    throw new AppError(400, 'invalid_image_count', `输出图片数量必须为 1-${config.maxOutputImages}`);
  }
  if (generation.outputFormat === 'png') generation.outputCompression = null;
  if (generation.outputFormat !== 'png' && generation.outputCompression === null) generation.outputCompression = 90;

  const hasEditableInput = assets.some((asset) => asset.role === 'reference' || asset.role === 'mask_target');
  const hasMask = assets.some((asset) => asset.role === 'mask');
  const hasMaskTarget = assets.some((asset) => asset.role === 'mask_target');
  if (hasMask !== hasMaskTarget) throw new AppError(400, 'invalid_mask_inputs', 'mask 与 mask_target 必须同时提供');
  if (generation.action === 'edit' && !hasEditableInput) {
    throw new AppError(400, 'missing_edit_input', '编辑计划必须包含参考图或遮罩目标图');
  }
  if (generation.action === 'generate' && hasMask) {
    throw new AppError(400, 'invalid_generate_input', '遮罩输入只能用于编辑计划');
  }
  if (hasMask && hasMaskTarget) {
    const mask = assets.find((asset) => asset.role === 'mask')!;
    const target = assets.find((asset) => asset.role === 'mask_target')!;
    if (mask.width !== target.width || mask.height !== target.height) {
      throw new AppError(400, 'mask_size_mismatch', 'mask 与 mask_target 尺寸必须一致');
    }
  }
  return generation;
}

export function validateAndConstrainDraft(
  input: unknown,
  preferences: PlanPreferences,
  assets: PlanInputView[],
  config: GatewayConfig,
  allowOpenShop: boolean,
): PlannerDraft {
  const parsed = plannerDraftSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(502, 'invalid_planner_output', 'Planner 返回了不符合策略的计划');
  }
  const draft = parsed.data;
  if (draft.operation.type === 'openshop.edit') {
    if (!allowOpenShop) throw new AppError(502, 'invalid_planner_output', '当前客户端不支持 OpenShop 计划');
    const editableInputs = assets.filter((asset) => asset.role !== 'mask');
    if (assets.length !== 1 || editableInputs.length !== 1 || editableInputs[0]?.role !== 'reference') {
      throw new AppError(400, 'invalid_openshop_input', 'OpenShop 编辑只接受一张已有图片，且不支持遮罩或多参考图');
    }
    const inputAsset = editableInputs[draft.operation.inputIndex];
    if (!inputAsset || draft.operation.inputIndex !== 0) {
      throw new AppError(400, 'invalid_openshop_input', 'OpenShop inputIndex 必须引用唯一输入图片');
    }
    return {
      assistantMessage: draft.assistantMessage,
      summary: draft.summary,
      operation: {
        type: 'openshop.edit',
        inputIndex: draft.operation.inputIndex,
        commands: draft.operation.commands,
        outputFormat: 'png',
      },
      assumptions: draft.assumptions,
      warnings: draft.warnings,
    } as PlannerDraft;
  }

  const generation = constrainGeneration(draft.operation.generation, preferences, assets, config);
  if ((draft.operation.type === 'image.generate' && generation.action !== 'generate')
    || (draft.operation.type === 'image.edit' && generation.action !== 'edit')) {
    throw new AppError(502, 'inconsistent_planner_output', 'Planner operation 与图片 action 不一致');
  }
  return {
    ...draft,
    operation: { ...draft.operation, generation },
  } as PlannerDraft;
}

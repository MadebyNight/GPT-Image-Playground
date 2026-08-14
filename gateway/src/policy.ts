import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GatewayConfig } from './config.js';
import { AppError } from './errors.js';
import { openShopCanvasCommandSchema } from './plan.js';
import type {
  ArtifactRef,
  ComposerSnapshotManifest,
  ConstrainedToolAgentPlannerDraft,
  FinalOutputSpec,
  GenerationPlan,
  ImageTransform,
  PlanInputView,
  PlanPreferences,
  PlannerDraft,
  PlannerArtifactRef,
  ToolAction,
} from './types.js';

export const POLICY_VERSION = 'tool-operation-v2';
export const TOOL_AGENT_V3_POLICY_VERSION = 'tool-operation-v3';
export const LEGACY_POLICY_VERSION = 'restricted-image-v1';
export const TOOL_PLAN_SCHEMA_VERSION = 2 as const;
export const TOOL_AGENT_PLAN_SCHEMA_VERSION = 3 as const;
export const ALLOWED_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const;
export const MAX_FINAL_OUTPUT_EDGE = 30_000;
export const MAX_FINAL_OUTPUT_PIXELS = 80_000_000;

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
  summary: z.string().trim().min(1).max(1000),
  operation: z.discriminatedUnion('type', [
    imageGenerateOperationSchema,
    imageEditOperationSchema,
    openShopDraftOperationSchema,
  ]),
  assumptions: z.array(z.string().trim().min(1).max(500)).max(12),
  warnings: z.array(z.string().trim().min(1).max(500)).max(12),
}).strict();

const imageDimensionSchema = z.number().int().min(1).max(MAX_FINAL_OUTPUT_EDGE);
const imageFormatSchema = z.enum(['png', 'jpeg', 'webp']);
const fitSchema = z.enum(['cover', 'contain', 'fill']);
const positionSchema = z.enum(['center', 'left', 'right', 'top', 'bottom']);
const rotationSchema = z.union([z.literal(90), z.literal(-90), z.literal(180), z.literal(-180)]);
const cropSchema = z.object({
  x: z.number().int().min(0).max(MAX_FINAL_OUTPUT_EDGE),
  y: z.number().int().min(0).max(MAX_FINAL_OUTPUT_EDGE),
  width: imageDimensionSchema,
  height: imageDimensionSchema,
}).strict().refine((crop) => crop.width * crop.height <= MAX_FINAL_OUTPUT_PIXELS, {
  message: `裁剪区域像素不得超过 ${MAX_FINAL_OUTPUT_PIXELS}`,
});

const finalOutputSpecSchema = z.object({
  width: imageDimensionSchema.optional(),
  height: imageDimensionSchema.optional(),
  fit: fitSchema.optional(),
  position: positionSchema.optional(),
  crop: cropSchema.optional(),
  rotate: rotationSchema.optional(),
  flip: z.enum(['horizontal', 'vertical']).optional(),
  outputFormat: imageFormatSchema.optional(),
  transparent: z.boolean().optional(),
  background: z.string().trim().min(1).max(128).optional(),
  outputCompression: z.number().int().min(0).max(100).nullable().optional(),
}).strict();

const imageTransformSchema = z.object({
  width: imageDimensionSchema.optional(),
  height: imageDimensionSchema.optional(),
  fit: fitSchema.optional(),
  position: positionSchema.optional(),
  crop: cropSchema.optional(),
  rotate: rotationSchema.optional(),
  flip: z.enum(['horizontal', 'vertical']).optional(),
  background: z.string().trim().min(1).max(128).optional(),
  outputFormat: imageFormatSchema,
  outputCompression: z.number().int().min(0).max(100).nullable().optional(),
}).strict();

const nullablePlannerFinalOutputSpecSchema = z.object({
  width: imageDimensionSchema.nullable(),
  height: imageDimensionSchema.nullable(),
  fit: fitSchema.nullable(),
  position: positionSchema.nullable(),
  crop: cropSchema.nullable(),
  rotate: rotationSchema.nullable(),
  flip: z.enum(['horizontal', 'vertical']).nullable(),
  outputFormat: imageFormatSchema,
  transparent: z.boolean().nullable(),
  background: z.string().trim().min(1).max(128).nullable(),
  outputCompression: z.number().int().min(0).max(100).nullable(),
}).strict().superRefine((spec, context) => {
  if ((spec.width === null) !== (spec.height === null)) {
    context.addIssue({ code: 'custom', path: ['width'], message: 'width 与 height 必须同时提供或同时为 null' });
  }
  if (spec.width !== null && spec.height !== null && spec.width * spec.height > MAX_FINAL_OUTPUT_PIXELS) {
    context.addIssue({ code: 'custom', path: ['width'], message: `最终尺寸像素不得超过 ${MAX_FINAL_OUTPUT_PIXELS}` });
  }
  if (spec.outputFormat === 'jpeg' && spec.transparent === true) {
    context.addIssue({ code: 'custom', path: ['transparent'], message: 'JPEG 不支持透明输出' });
  }
});

const nullablePlannerImageTransformSchema = z.object({
  width: imageDimensionSchema.nullable(),
  height: imageDimensionSchema.nullable(),
  fit: fitSchema.nullable(),
  position: positionSchema.nullable(),
  crop: cropSchema.nullable(),
  rotate: rotationSchema.nullable(),
  flip: z.enum(['horizontal', 'vertical']).nullable(),
  background: z.string().trim().min(1).max(128).nullable(),
  outputFormat: imageFormatSchema,
  outputCompression: z.number().int().min(0).max(100).nullable(),
}).strict().superRefine((transform, context) => {
  if ((transform.width === null) !== (transform.height === null)) {
    context.addIssue({ code: 'custom', path: ['width'], message: 'width 与 height 必须同时提供或同时为 null' });
  }
  if (transform.width !== null && transform.height !== null && transform.width * transform.height > MAX_FINAL_OUTPUT_PIXELS) {
    context.addIssue({ code: 'custom', path: ['width'], message: `最终尺寸像素不得超过 ${MAX_FINAL_OUTPUT_PIXELS}` });
  }
});

const plannerPlanInputArtifactRefSchema = z.object({
  kind: z.literal('plan_input'),
  inputIndex: z.number().int().min(0),
}).strict();
const plannerActionOutputArtifactRefSchema = z.object({
  kind: z.literal('action_output'),
  actionIndex: z.number().int().min(0).max(2),
}).strict();
const plannerArtifactRefSchema = z.discriminatedUnion('kind', [
  plannerPlanInputArtifactRefSchema,
  plannerActionOutputArtifactRefSchema,
]);
const imageGeneratePlannerActionSchema = z.object({
  type: z.literal('image.generate'),
  generation: generationSchema.extend({ action: z.literal('generate') }).strict(),
}).strict();
const imageEditPlannerActionSchema = z.object({
  type: z.literal('image.edit'),
  generation: generationSchema.extend({ action: z.literal('edit') }).strict(),
}).strict();
const imageTransformPlannerActionSchema = z.object({
  type: z.literal('image.transform'),
  input: plannerArtifactRefSchema,
  transform: nullablePlannerImageTransformSchema,
}).strict();
const metadataAssertPlannerActionSchema = z.object({
  type: z.literal('metadata.assert'),
  input: plannerArtifactRefSchema,
  expected: nullablePlannerFinalOutputSpecSchema,
}).strict();

export const toolAgentPlannerDraftSchema = z.object({
  summary: z.string().trim().min(1).max(1000),
  actions: z.array(z.discriminatedUnion('type', [
    imageGeneratePlannerActionSchema,
    imageEditPlannerActionSchema,
    imageTransformPlannerActionSchema,
    metadataAssertPlannerActionSchema,
  ])).min(1).max(3),
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
  required: ['summary', 'operation', 'assumptions', 'warnings'],
  properties: {
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

const nullableDimensionJsonSchema = {
  anyOf: [
    { type: 'integer', minimum: 1, maximum: MAX_FINAL_OUTPUT_EDGE },
    { type: 'null' },
  ],
} as const;
const nullableStringEnumJsonSchema = (values: readonly string[]) => ({
  anyOf: [
    { type: 'string', enum: values },
    { type: 'null' },
  ],
});
const nullableStringJsonSchema = {
  anyOf: [
    { type: 'string', minLength: 1, maxLength: 128 },
    { type: 'null' },
  ],
} as const;
const nullableCompressionJsonSchema = {
  anyOf: [
    { type: 'integer', minimum: 0, maximum: 100 },
    { type: 'null' },
  ],
} as const;
const nullableBooleanJsonSchema = {
  anyOf: [
    { type: 'boolean' },
    { type: 'null' },
  ],
} as const;
const nullableRotationJsonSchema = {
  anyOf: [
    { type: 'integer', enum: [90, -90, 180, -180] },
    { type: 'null' },
  ],
} as const;
const cropJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'width', 'height'],
  properties: {
    x: { type: 'integer', minimum: 0, maximum: MAX_FINAL_OUTPUT_EDGE },
    y: { type: 'integer', minimum: 0, maximum: MAX_FINAL_OUTPUT_EDGE },
    width: { type: 'integer', minimum: 1, maximum: MAX_FINAL_OUTPUT_EDGE },
    height: { type: 'integer', minimum: 1, maximum: MAX_FINAL_OUTPUT_EDGE },
  },
} as const;
const nullableCropJsonSchema = {
  anyOf: [cropJsonSchema, { type: 'null' }],
} as const;
const plannerFinalOutputSpecJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'width', 'height', 'fit', 'position', 'crop', 'rotate', 'flip',
    'outputFormat', 'transparent', 'background', 'outputCompression',
  ],
  properties: {
    width: nullableDimensionJsonSchema,
    height: nullableDimensionJsonSchema,
    fit: nullableStringEnumJsonSchema(['cover', 'contain', 'fill']),
    position: nullableStringEnumJsonSchema(['center', 'left', 'right', 'top', 'bottom']),
    crop: nullableCropJsonSchema,
    rotate: nullableRotationJsonSchema,
    flip: nullableStringEnumJsonSchema(['horizontal', 'vertical']),
    outputFormat: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
    transparent: nullableBooleanJsonSchema,
    background: nullableStringJsonSchema,
    outputCompression: nullableCompressionJsonSchema,
  },
} as const;
const plannerImageTransformJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'width', 'height', 'fit', 'position', 'crop', 'rotate', 'flip',
    'background', 'outputFormat', 'outputCompression',
  ],
  properties: {
    width: nullableDimensionJsonSchema,
    height: nullableDimensionJsonSchema,
    fit: nullableStringEnumJsonSchema(['cover', 'contain', 'fill']),
    position: nullableStringEnumJsonSchema(['center', 'left', 'right', 'top', 'bottom']),
    crop: nullableCropJsonSchema,
    rotate: nullableRotationJsonSchema,
    flip: nullableStringEnumJsonSchema(['horizontal', 'vertical']),
    background: nullableStringJsonSchema,
    outputFormat: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
    outputCompression: nullableCompressionJsonSchema,
  },
} as const;
const plannerArtifactRefJsonSchema = {
  anyOf: [
    {
      type: 'object', additionalProperties: false, required: ['kind', 'inputIndex'],
      properties: {
        kind: { type: 'string', enum: ['plan_input'] },
        inputIndex: { type: 'integer', minimum: 0 },
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'actionIndex'],
      properties: {
        kind: { type: 'string', enum: ['action_output'] },
        actionIndex: { type: 'integer', minimum: 0, maximum: 2 },
      },
    },
  ],
} as const;
const v3GenerationJsonSchema = {
  ...generationJsonSchema,
  properties: {
    ...generationJsonSchema.properties,
    imageCount: { type: 'integer', enum: [1] },
  },
} as const;

/** Responses 的 v3 结构化输出合同；不会向 Planner 暴露 Gateway asset UUID。 */
export const toolAgentPlannerJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'actions', 'assumptions', 'warnings'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 1000 },
    actions: {
      type: 'array', minItems: 1, maxItems: 3,
      items: {
        anyOf: [
          {
            type: 'object', additionalProperties: false, required: ['type', 'generation'],
            properties: {
              type: { type: 'string', enum: ['image.generate'] },
              generation: {
                ...v3GenerationJsonSchema,
                properties: { ...v3GenerationJsonSchema.properties, action: { type: 'string', enum: ['generate'] } },
              },
            },
          },
          {
            type: 'object', additionalProperties: false, required: ['type', 'generation'],
            properties: {
              type: { type: 'string', enum: ['image.edit'] },
              generation: {
                ...v3GenerationJsonSchema,
                properties: { ...v3GenerationJsonSchema.properties, action: { type: 'string', enum: ['edit'] } },
              },
            },
          },
          {
            type: 'object', additionalProperties: false, required: ['type', 'input', 'transform'],
            properties: {
              type: { type: 'string', enum: ['image.transform'] },
              input: plannerArtifactRefJsonSchema,
              transform: plannerImageTransformJsonSchema,
            },
          },
          {
            type: 'object', additionalProperties: false, required: ['type', 'input', 'expected'],
            properties: {
              type: { type: 'string', enum: ['metadata.assert'] },
              input: plannerArtifactRefJsonSchema,
              expected: plannerFinalOutputSpecJsonSchema,
            },
          },
        ],
      },
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

function assertFinalDimensionsWithinConfig(spec: FinalOutputSpec | ImageTransform, config: GatewayConfig): void {
  if ((spec.width === undefined) !== (spec.height === undefined)) {
    throw new AppError(400, 'invalid_final_output_spec', 'width 与 height 必须同时提供或同时省略');
  }
  if (spec.width && spec.height && spec.width * spec.height > config.maxImagePixels) {
    throw new AppError(400, 'final_output_too_large', `最终输出像素不得超过 ${config.maxImagePixels}`);
  }
  if (spec.crop && spec.crop.width * spec.crop.height > config.maxImagePixels) {
    throw new AppError(400, 'final_output_too_large', `裁剪区域像素不得超过 ${config.maxImagePixels}`);
  }
}

/**
 * 将路由器传入的最终规格收敛为 Gateway 可执行的明确参数。该函数是 v3
 * 自动提交接口的唯一规格入口，因此再次验证尺寸、JPEG 透明冲突和压缩。
 */
export function normalizeFinalOutputSpec(
  input: unknown,
  preferences: PlanPreferences,
  config: GatewayConfig,
): FinalOutputSpec {
  const parsed = finalOutputSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, 'invalid_final_output_spec', '最终输出规格 schema 无效');
  }
  const raw = parsed.data;
  assertFinalDimensionsWithinConfig(raw, config);
  const outputFormat = raw.outputFormat ?? preferences.outputFormat ?? 'png';
  if (outputFormat === 'jpeg' && raw.transparent === true) {
    throw new AppError(400, 'transparent_jpeg_conflict', 'JPEG 不支持透明背景，请改用 PNG 或 WebP');
  }
  const outputCompression = outputFormat === 'png'
    ? null
    : raw.outputCompression ?? preferences.outputCompression ?? 90;
  const background = outputFormat === 'jpeg' && raw.fit === 'contain' && !raw.background
    ? '#ffffff'
    : raw.background;
  return {
    ...raw,
    outputFormat,
    outputCompression,
    ...(background ? { background } : {}),
  };
}

function normalizePlannerFinalOutputSpec(
  input: z.infer<typeof nullablePlannerFinalOutputSpecSchema>,
): FinalOutputSpec {
  return {
    ...(input.width === null ? {} : { width: input.width }),
    ...(input.height === null ? {} : { height: input.height }),
    ...(input.fit === null ? {} : { fit: input.fit }),
    ...(input.position === null ? {} : { position: input.position }),
    ...(input.crop === null ? {} : { crop: input.crop }),
    ...(input.rotate === null ? {} : { rotate: input.rotate }),
    ...(input.flip === null ? {} : { flip: input.flip }),
    outputFormat: input.outputFormat,
    ...(input.transparent === null ? {} : { transparent: input.transparent }),
    ...(input.background === null ? {} : { background: input.background }),
    outputCompression: input.outputCompression,
  };
}

function normalizePlannerImageTransform(
  input: z.infer<typeof nullablePlannerImageTransformSchema>,
): ImageTransform {
  return {
    ...(input.width === null ? {} : { width: input.width }),
    ...(input.height === null ? {} : { height: input.height }),
    ...(input.fit === null ? {} : { fit: input.fit }),
    ...(input.position === null ? {} : { position: input.position }),
    ...(input.crop === null ? {} : { crop: input.crop }),
    ...(input.rotate === null ? {} : { rotate: input.rotate }),
    ...(input.flip === null ? {} : { flip: input.flip }),
    ...(input.background === null ? {} : { background: input.background }),
    outputFormat: input.outputFormat,
    outputCompression: input.outputCompression,
  };
}

function sameCrop(
  left: FinalOutputSpec['crop'] | ImageTransform['crop'],
  right: FinalOutputSpec['crop'] | ImageTransform['crop'],
): boolean {
  return left?.x === right?.x
    && left?.y === right?.y
    && left?.width === right?.width
    && left?.height === right?.height;
}

function sameFinalOutputSpec(left: FinalOutputSpec, right: FinalOutputSpec): boolean {
  return left.width === right.width
    && left.height === right.height
    && left.fit === right.fit
    && left.position === right.position
    && sameCrop(left.crop, right.crop)
    && left.rotate === right.rotate
    && left.flip === right.flip
    && left.outputFormat === right.outputFormat
    && left.transparent === right.transparent
    && left.background === right.background
    && left.outputCompression === right.outputCompression;
}

function transformMatchesFinalOutputSpec(transform: ImageTransform, expected: FinalOutputSpec): boolean {
  return transform.width === expected.width
    && transform.height === expected.height
    && transform.fit === expected.fit
    && transform.position === expected.position
    && sameCrop(transform.crop, expected.crop)
    && transform.rotate === expected.rotate
    && transform.flip === expected.flip
    && transform.outputFormat === expected.outputFormat
    && transform.background === expected.background
    && transform.outputCompression === expected.outputCompression;
}

function plannerOutputError(message: string): never {
  throw new AppError(502, 'invalid_planner_output', message);
}

function resolvePlannerArtifactRef(
  reference: PlannerArtifactRef,
  actionIndex: number,
  assets: PlanInputView[],
): ArtifactRef {
  if (reference.kind === 'plan_input') {
    const input = assets[reference.inputIndex];
    if (!input || input.role === 'mask') {
      return plannerOutputError('Planner plan_input 必须引用有效的可编辑输入图片');
    }
    return { kind: 'plan_input', assetId: input.assetId };
  }
  if (reference.actionIndex >= actionIndex) {
    return plannerOutputError('Planner action 输出引用只能指向更早的 action');
  }
  return { kind: 'action_output', actionIndex: reference.actionIndex };
}

function validateToolAgentActionSequence(actions: Array<{ type: string }>): void {
  const types = actions.map((action) => action.type);
  const generationChain = types.length === 3
    && (types[0] === 'image.generate' || types[0] === 'image.edit')
    && types[1] === 'image.transform'
    && types[2] === 'metadata.assert';
  const transformChain = types.length === 2
    && types[0] === 'image.transform'
    && types[1] === 'metadata.assert';
  if (!generationChain && !transformChain) {
    plannerOutputError('Planner v3 action 顺序仅允许 generate/edit → transform → assert 或 transform → assert');
  }
}

/**
 * 将 v3 Planner 的 action 链转为持久化合同。模型参数不会直接被信任：
 * 规格、顺序、前向引用、输入资产和单图生成均在此 fail closed。
 */
export function validateAndConstrainToolAgentDraft(
  input: unknown,
  preferences: PlanPreferences,
  assets: PlanInputView[],
  config: GatewayConfig,
  finalOutputSpecInput: unknown,
): ConstrainedToolAgentPlannerDraft {
  const parsed = toolAgentPlannerDraftSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(502, 'invalid_planner_output', 'Planner 返回了不符合 v3 策略的 action 链');
  }
  const finalOutputSpec = normalizeFinalOutputSpec(finalOutputSpecInput, preferences, config);
  validateToolAgentActionSequence(parsed.data.actions);
  if (preferences.imageCount !== undefined && preferences.imageCount !== 1) {
    throw new AppError(400, 'invalid_image_count', '严格输出 action 链只能生成一张图片');
  }

  const actions: ToolAction[] = parsed.data.actions.map((action, actionIndex) => {
    if (action.type === 'image.generate' || action.type === 'image.edit') {
      if (action.generation.imageCount !== 1) {
        return plannerOutputError('带后处理的生成 action 的 imageCount 必须为 1');
      }
      const generation = constrainGeneration(action.generation, {
        ...preferences,
        outputFormat: finalOutputSpec.outputFormat,
        ...(finalOutputSpec.outputCompression === null || finalOutputSpec.outputCompression === undefined
          ? {}
          : { outputCompression: finalOutputSpec.outputCompression }),
        imageCount: 1,
      }, assets, config);
      return { type: action.type, generation } as ToolAction;
    }

    const reference = resolvePlannerArtifactRef(action.input, actionIndex, assets);
    if (action.type === 'image.transform') {
      const transform = normalizePlannerImageTransform(action.transform);
      assertFinalDimensionsWithinConfig(transform, config);
      if (!transformMatchesFinalOutputSpec(transform, finalOutputSpec)) {
        return plannerOutputError('Planner transform 必须与冻结的最终输出规格一致');
      }
      return { type: 'image.transform', input: reference, transform };
    }

    const expected = normalizePlannerFinalOutputSpec(action.expected);
    assertFinalDimensionsWithinConfig(expected, config);
    if (!sameFinalOutputSpec(expected, finalOutputSpec)) {
      return plannerOutputError('Planner metadata.assert 必须断言冻结的最终输出规格');
    }
    return { type: 'metadata.assert', input: reference, expected };
  });

  const first = actions[0];
  const second = actions[1];
  if (actions.length === 3) {
    const transform = actions[1];
    const assertion = actions[2];
    if (transform?.type !== 'image.transform' || transform.input.kind !== 'action_output' || transform.input.actionIndex !== 0
      || assertion?.type !== 'metadata.assert' || assertion.input.kind !== 'action_output' || assertion.input.actionIndex !== 1) {
      plannerOutputError('v3 generation action 链必须逐步引用前一 action 输出');
    }
  } else if (first?.type !== 'image.transform' || first.input.kind !== 'plan_input'
    || second?.type !== 'metadata.assert' || second.input.kind !== 'action_output' || second.input.actionIndex !== 0) {
    plannerOutputError('v3 纯 transform action 链必须由 plan_input → transform → assert 组成');
  }

  const rawFinalSpec = finalOutputSpecInput as Record<string, unknown> | null;
  const assumptions = [...parsed.data.assumptions];
  if (finalOutputSpec.outputFormat === 'jpeg' && finalOutputSpec.fit === 'contain'
    && finalOutputSpec.background === '#ffffff' && (!rawFinalSpec || rawFinalSpec.background === undefined)) {
    assumptions.push('JPEG contain 输出未指定背景，已使用白色背景。');
  }
  return {
    summary: parsed.data.summary,
    actions,
    finalOutputSpec,
    assumptions,
    warnings: parsed.data.warnings,
  };
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

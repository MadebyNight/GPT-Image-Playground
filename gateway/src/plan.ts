import { z } from 'zod';
import { AppError } from './errors.js';
import type {
  FinalOutputSpec,
  GenerationPlan,
  ImageTransform,
  ImageToolOperation,
  LegacyRestrictedAgentPlanSnapshot,
  OpenShopCanvasCommand,
  RestrictedAgentPlanSnapshot,
  ToolAgentPlanSnapshot,
  ToolAgentPlanV3Snapshot,
  ToolAction,
  ToolOperation,
  WebSearchReference,
} from './types.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const planStatusSchema = z.enum([
  'awaiting_confirmation', 'queued', 'executing', 'completed', 'failed',
  'cancelled', 'failed_unknown', 'expired',
]);
const inputSchema = z.object({
  assetId: z.string().uuid(),
  role: z.enum(['reference', 'mask_target', 'mask']),
  sha256: sha256Schema,
  mimeType: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();
const generationSchema = z.object({
  exactPrompt: z.string().min(1),
  action: z.enum(['generate', 'edit']),
  size: z.string().min(1),
  quality: z.enum(['auto', 'low', 'medium', 'high']),
  outputFormat: z.enum(['png', 'jpeg', 'webp']),
  outputCompression: z.number().int().min(0).max(100).nullable(),
  imageCount: z.number().int().positive(),
}).strict();
const planStepSchema = z.object({
  title: z.string().min(1),
  operation: z.enum(['generate', 'edit']),
}).strict();

const cropCommandSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.literal('canvas.crop'),
  target: z.literal('document'),
  args: z.object({
    x: z.number().int().min(0).max(30_000),
    y: z.number().int().min(0).max(30_000),
    width: z.number().int().min(1).max(30_000),
    height: z.number().int().min(1).max(30_000),
  }).strict().refine((args) => args.width * args.height <= 80_000_000),
}).strict();
const rotateCommandSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.literal('canvas.rotate'),
  target: z.literal('document'),
  args: z.object({ degrees: z.union([z.literal(90), z.literal(-90), z.literal(180), z.literal(-180)]) }).strict(),
}).strict();
const flipCommandSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.literal('canvas.flip'),
  target: z.literal('document'),
  args: z.object({ axis: z.enum(['h', 'v']) }).strict(),
}).strict();
const flattenCommandSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.literal('canvas.flatten'),
  target: z.literal('document'),
  args: z.object({}).strict(),
}).strict();
export const openShopCanvasCommandSchema = z.discriminatedUnion('id', [
  cropCommandSchema, rotateCommandSchema, flipCommandSchema, flattenCommandSchema,
]);

const imageGenerateOperationSchema = z.object({
  type: z.literal('image.generate'),
  generation: generationSchema.extend({ action: z.literal('generate') }).strict(),
}).strict();
const imageEditOperationSchema = z.object({
  type: z.literal('image.edit'),
  generation: generationSchema.extend({ action: z.literal('edit') }).strict(),
}).strict();
const openShopOperationSchema = z.object({
  type: z.literal('openshop.edit'),
  inputAssetId: z.string().uuid(),
  commands: z.array(openShopCanvasCommandSchema).min(1).max(5),
  outputFormat: z.literal('png'),
}).strict();
const toolOperationSchema = z.discriminatedUnion('type', [
  imageGenerateOperationSchema, imageEditOperationSchema, openShopOperationSchema,
]);

const imageDimensionSchema = z.number().int().min(1).max(30_000);
const imageFormatSchema = z.enum(['png', 'jpeg', 'webp']);
const fitSchema = z.enum(['cover', 'contain', 'fill']);
const positionSchema = z.enum(['center', 'left', 'right', 'top', 'bottom']);
const rotationSchema = z.union([z.literal(90), z.literal(-90), z.literal(180), z.literal(-180)]);
const cropSchema = z.object({
  x: z.number().int().min(0).max(30_000),
  y: z.number().int().min(0).max(30_000),
  width: imageDimensionSchema,
  height: imageDimensionSchema,
}).strict().refine((crop) => crop.width * crop.height <= 80_000_000, {
  message: '裁剪区域像素不得超过 80_000_000',
});

const finalOutputSpecShape = {
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
};
const finalOutputSpecSchema = z.object(finalOutputSpecShape).strict().superRefine((spec, context) => {
  if ((spec.width === undefined) !== (spec.height === undefined)) {
    context.addIssue({ code: 'custom', path: ['width'], message: '最终输出 width 与 height 必须同时提供或同时省略' });
  }
  if (spec.width && spec.height && spec.width * spec.height > 80_000_000) {
    context.addIssue({ code: 'custom', path: ['width'], message: '最终尺寸像素不得超过 80_000_000' });
  }
  if (spec.outputFormat === 'jpeg' && spec.transparent === true) {
    context.addIssue({ code: 'custom', path: ['transparent'], message: 'JPEG 不支持透明输出' });
  }
});
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
}).strict().superRefine((transform, context) => {
  if ((transform.width === undefined) !== (transform.height === undefined)) {
    context.addIssue({ code: 'custom', path: ['width'], message: '变换 width 与 height 必须同时提供或同时省略' });
  }
  if (transform.width && transform.height && transform.width * transform.height > 80_000_000) {
    context.addIssue({ code: 'custom', path: ['width'], message: '最终尺寸像素不得超过 80_000_000' });
  }
});

const planInputArtifactRefSchema = z.object({
  kind: z.literal('plan_input'),
  assetId: z.string().uuid(),
}).strict();
const actionOutputArtifactRefSchema = z.object({
  kind: z.literal('action_output'),
  actionIndex: z.number().int().min(0).max(2),
}).strict();
const artifactRefSchema = z.discriminatedUnion('kind', [
  planInputArtifactRefSchema,
  actionOutputArtifactRefSchema,
]);
const imageGenerateActionSchema = z.object({
  type: z.literal('image.generate'),
  generation: generationSchema.extend({ action: z.literal('generate') }).strict(),
}).strict();
const imageEditActionSchema = z.object({
  type: z.literal('image.edit'),
  generation: generationSchema.extend({ action: z.literal('edit') }).strict(),
}).strict();
const imageTransformActionSchema = z.object({
  type: z.literal('image.transform'),
  input: artifactRefSchema,
  transform: imageTransformSchema,
}).strict();
const metadataAssertActionSchema = z.object({
  type: z.literal('metadata.assert'),
  input: artifactRefSchema,
  expected: finalOutputSpecSchema,
}).strict();
const toolActionSchema = z.discriminatedUnion('type', [
  imageGenerateActionSchema,
  imageEditActionSchema,
  imageTransformActionSchema,
  metadataAssertActionSchema,
]);

const planBaseShape = {
  id: z.string().min(1),
  version: z.number().int().positive(),
  status: planStatusSchema,
  expiresAt: z.string().datetime(),
  originalRequest: z.string(),
  summary: z.string().min(1),
  inputs: z.array(inputSchema),
  assumptions: z.array(z.string()),
  warnings: z.array(z.string()),
  policyVersion: z.string().min(1),
  webSearch: z.object({
    enabled: z.literal(true),
    sources: z.array(z.object({
      title: z.string().min(1).max(300),
      url: z.string().url(),
      description: z.string().max(1_000),
      engine: z.string().min(1).max(64),
    }).strict()).max(10),
  }).strict().optional(),
};
const legacyPlanSchema = z.object({
  ...planBaseShape,
  steps: z.array(planStepSchema).min(1),
  generation: generationSchema,
}).strict().superRefine((plan, context) => {
  if (plan.steps.some((step) => step.operation !== plan.generation.action)) {
    context.addIssue({ code: 'custom', path: ['steps'], message: '旧版步骤与 generation action 不一致' });
  }
});
const toolPlanSchema = z.object({
  ...planBaseShape,
  schemaVersion: z.literal(2),
  composerSnapshotHash: sha256Schema,
  operation: toolOperationSchema,
}).strict().superRefine((plan, context) => {
  if (plan.operation.type === 'openshop.edit') {
    const inputAssetId = plan.operation.inputAssetId;
    if (plan.inputs.some((input) => input.assetId === inputAssetId && input.role === 'reference')) return;
    context.addIssue({
      code: 'custom',
      path: ['operation', 'inputAssetId'],
      message: 'OpenShop inputAssetId 未引用计划中的 reference asset',
    });
  }
});

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

function addActionIssue(
  context: z.RefinementCtx,
  path: Array<string | number>,
  message: string,
): void {
  context.addIssue({ code: 'custom', path, message });
}

const toolAgentPlanV3Schema = z.object({
  ...planBaseShape,
  schemaVersion: z.literal(3),
  composerSnapshotHash: sha256Schema,
  finalOutputSpec: finalOutputSpecSchema.nullable(),
  actions: z.array(toolActionSchema).min(1).max(3),
}).strict().superRefine((plan, context) => {
  const { actions } = plan;
  const finalOutputSpec = plan.finalOutputSpec;
  if (!finalOutputSpec) {
    addActionIssue(context, ['finalOutputSpec'], 'v3 action 链必须冻结最终输出规格');
  }

  for (const [index, action] of actions.entries()) {
    if (action.type === 'image.transform' || action.type === 'metadata.assert') {
      const reference = action.input;
      if (reference.kind === 'plan_input') {
        const input = plan.inputs.find((candidate) => candidate.assetId === reference.assetId);
        if (!input || input.role === 'mask') {
          addActionIssue(context, ['actions', index, 'input'], 'plan_input 引用必须指向计划中的可编辑输入资产');
        }
      } else if (reference.actionIndex >= index) {
        addActionIssue(context, ['actions', index, 'input'], 'action 输出引用只能指向更早的 action');
      }
    }
  }

  const first = actions[0];
  const second = actions[1];
  const third = actions[2];
  if (actions.length === 3
    && (first?.type === 'image.generate' || first?.type === 'image.edit')
    && second?.type === 'image.transform'
    && third?.type === 'metadata.assert') {
    const generation = first.generation;
    if (generation.imageCount !== 1) {
      addActionIssue(context, ['actions', 0, 'generation', 'imageCount'], '带后处理的生成计划 imageCount 必须为 1');
    }
    if (first.type === 'image.edit'
      && !plan.inputs.some((input) => input.role === 'reference' || input.role === 'mask_target')) {
      addActionIssue(context, ['actions', 0], 'image.edit 必须引用至少一张可编辑输入图片');
    }
    if (first.type === 'image.generate' && plan.inputs.some((input) => input.role === 'mask')) {
      addActionIssue(context, ['actions', 0], 'image.generate 不能使用 mask 输入');
    }
    if (second.input.kind !== 'action_output' || second.input.actionIndex !== 0) {
      addActionIssue(context, ['actions', 1, 'input'], 'transform 必须引用前一 generation action 的输出');
    }
    if (third.input.kind !== 'action_output' || third.input.actionIndex !== 1) {
      addActionIssue(context, ['actions', 2, 'input'], 'metadata.assert 必须引用前一 transform action 的输出');
    }
    if (finalOutputSpec) {
      if (!transformMatchesFinalOutputSpec(second.transform, finalOutputSpec)) {
        addActionIssue(context, ['actions', 1, 'transform'], 'transform 必须与冻结的最终输出规格一致');
      }
      if (!sameFinalOutputSpec(third.expected, finalOutputSpec)) {
        addActionIssue(context, ['actions', 2, 'expected'], 'metadata.assert 必须断言冻结的最终输出规格');
      }
    }
    return;
  }

  if (actions.length === 2 && first?.type === 'image.transform' && second?.type === 'metadata.assert') {
    if (first.input.kind !== 'plan_input') {
      addActionIssue(context, ['actions', 0, 'input'], '纯 transform 必须引用计划输入资产');
    }
    if (second.input.kind !== 'action_output' || second.input.actionIndex !== 0) {
      addActionIssue(context, ['actions', 1, 'input'], 'metadata.assert 必须引用前一 transform action 的输出');
    }
    if (finalOutputSpec) {
      if (!transformMatchesFinalOutputSpec(first.transform, finalOutputSpec)) {
        addActionIssue(context, ['actions', 0, 'transform'], 'transform 必须与冻结的最终输出规格一致');
      }
      if (!sameFinalOutputSpec(second.expected, finalOutputSpec)) {
        addActionIssue(context, ['actions', 1, 'expected'], 'metadata.assert 必须断言冻结的最终输出规格');
      }
    }
    return;
  }

  addActionIssue(context, ['actions'], 'v3 action 顺序仅允许 generate/edit → transform → assert 或 transform → assert');
});

const planSnapshotSchema = z.union([legacyPlanSchema, toolPlanSchema, toolAgentPlanV3Schema]);

export function decodeRestrictedAgentPlanSnapshot(input: unknown): RestrictedAgentPlanSnapshot {
  const result = planSnapshotSchema.safeParse(input);
  if (!result.success) {
    throw new AppError(500, 'invalid_plan_snapshot', '计划快照 schema 无效', {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
    });
  }
  return result.data as RestrictedAgentPlanSnapshot;
}

export function isToolAgentPlan(plan: RestrictedAgentPlanSnapshot): plan is ToolAgentPlanSnapshot {
  return plan.schemaVersion === 2;
}

export function isToolAgentPlanV3(plan: RestrictedAgentPlanSnapshot): plan is ToolAgentPlanV3Snapshot {
  return plan.schemaVersion === 3;
}

export function getPlanOperation(plan: RestrictedAgentPlanSnapshot): ToolOperation {
  if (isToolAgentPlanV3(plan)) {
    throw new AppError(409, 'v3_actions_require_auto_execution', 'v3 action 链只能通过自动执行接口运行');
  }
  if (isToolAgentPlan(plan)) return plan.operation;
  return {
    type: plan.generation.action === 'generate' ? 'image.generate' : 'image.edit',
    generation: plan.generation,
  } as ImageToolOperation;
}

export function getImageGeneration(plan: RestrictedAgentPlanSnapshot): GenerationPlan | null {
  const operation = getPlanOperation(plan);
  return operation.type === 'image.generate' || operation.type === 'image.edit'
    ? operation.generation
    : null;
}

export function requireImageGeneration(plan: RestrictedAgentPlanSnapshot): GenerationPlan {
  const generation = getImageGeneration(plan);
  if (!generation) {
    throw new AppError(409, 'client_operation_requires_browser', 'OpenShop 编辑必须由当前浏览器确认后执行');
  }
  return generation;
}

export type DecodedLegacyPlan = LegacyRestrictedAgentPlanSnapshot;
export type DecodedToolPlan = ToolAgentPlanSnapshot;
export type DecodedToolPlanV3 = ToolAgentPlanV3Snapshot;
export type DecodedOpenShopCommand = OpenShopCanvasCommand;

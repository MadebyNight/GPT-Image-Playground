import { z } from 'zod';
import { AppError } from './errors.js';
import type {
  GenerationPlan,
  ImageToolOperation,
  LegacyRestrictedAgentPlanSnapshot,
  OpenShopCanvasCommand,
  RestrictedAgentPlanSnapshot,
  ToolAgentPlanSnapshot,
  ToolOperation,
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
const planSnapshotSchema = z.union([legacyPlanSchema, toolPlanSchema]);

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

export function getPlanOperation(plan: RestrictedAgentPlanSnapshot): ToolOperation {
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
export type DecodedOpenShopCommand = OpenShopCanvasCommand;

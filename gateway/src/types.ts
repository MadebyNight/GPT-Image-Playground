export const PLAN_STATUSES = [
  'awaiting_confirmation',
  'queued',
  'executing',
  'completed',
  'failed',
  'cancelled',
  'failed_unknown',
  'expired',
] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const EXECUTION_STATUSES = [
  'queued',
  'executing',
  'completed',
  'failed',
  'cancelled',
  'failed_unknown',
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const EXECUTION_ACTION_STATUSES = [
  'queued',
  'executing',
  'completed',
  'failed',
  'cancelled',
  'failed_unknown',
] as const;

export type ExecutionActionStatus = (typeof EXECUTION_ACTION_STATUSES)[number];

export type AssetRole = 'reference' | 'mask_target' | 'mask' | 'generated';
export type PlanInputRole = Exclude<AssetRole, 'generated'>;

export interface StoredAsset {
  id: string;
  planId: string | null;
  executionId: string | null;
  sessionId: string;
  direction: 'input' | 'output';
  role: AssetRole;
  mimeType: string;
  sha256: string;
  /** 上传文件在 Gateway 规范化前的原始字节 SHA-256，仅输入资产存在。 */
  sourceSha256?: string;
  storagePath: string;
  byteSize: number;
  width: number;
  height: number;
  expiresAt: number;
  createdAt: number;
}

export interface PlanInputView {
  assetId: string;
  role: PlanInputRole;
  sha256: string;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * 自动执行响应把 Gateway 资产与 Composer 中的浏览器图片绑定对应起来。
 * Gateway 不接收前端任务元数据，因此 sourceTaskId 当前始终为 null。
 */
export interface AutoPlanAssetBinding {
  gatewayAssetId: string;
  browserImageId: string | null;
  sourceTaskId: null;
  role: PlanInputRole;
  ordinal: number;
}

export interface WebSearchSource {
  title: string;
  url: string;
  description: string;
  engine: string;
}

export interface WebSearchReference {
  enabled: true;
  sources: WebSearchSource[];
}

export interface PlanStep {
  title: string;
  operation: 'generate' | 'edit';
}

export interface GenerationPlan {
  exactPrompt: string;
  action: 'generate' | 'edit';
  size: string;
  quality: 'auto' | 'low' | 'medium' | 'high';
  outputFormat: 'png' | 'jpeg' | 'webp';
  outputCompression: number | null;
  imageCount: number;
}

/**
 * 用户可见的最终交付规格。它独立于 Images API 的候选尺寸，供 v3
 * transform 与 metadata.assert 使用。
 */
export interface FinalOutputSpec {
  width?: number;
  height?: number;
  fit?: 'cover' | 'contain' | 'fill';
  position?: 'center' | 'left' | 'right' | 'top' | 'bottom';
  crop?: { x: number; y: number; width: number; height: number };
  rotate?: 90 | -90 | 180 | -180;
  flip?: 'horizontal' | 'vertical';
  outputFormat?: 'png' | 'jpeg' | 'webp';
  transparent?: boolean;
  background?: string;
  outputCompression?: number | null;
}

/** Gateway 的确定性图片变换参数。 */
export interface ImageTransform {
  width?: number;
  height?: number;
  fit?: 'cover' | 'contain' | 'fill';
  position?: 'center' | 'left' | 'right' | 'top' | 'bottom';
  crop?: { x: number; y: number; width: number; height: number };
  rotate?: 90 | -90 | 180 | -180;
  flip?: 'horizontal' | 'vertical';
  background?: string;
  outputFormat: 'png' | 'jpeg' | 'webp';
  outputCompression?: number | null;
}

/** v3 action 之间唯一允许的资产引用；浏览器侧 ID 永不进入该合同。 */
export type ArtifactRef =
  | { kind: 'plan_input'; assetId: string }
  | { kind: 'action_output'; actionIndex: number };

export type ToolAction =
  | { type: 'image.generate'; generation: GenerationPlan & { action: 'generate' } }
  | { type: 'image.edit'; generation: GenerationPlan & { action: 'edit' } }
  | { type: 'image.transform'; input: ArtifactRef; transform: ImageTransform }
  | { type: 'metadata.assert'; input: ArtifactRef; expected: FinalOutputSpec };

/**
 * Planner 只能按输入顺序引用资产。Gateway 将它解析为 ArtifactRef，
 * 因而 Planner 永远不能提交 Gateway asset UUID。
 */
export type PlannerArtifactRef =
  | { kind: 'plan_input'; inputIndex: number }
  | { kind: 'action_output'; actionIndex: number };

export type ToolAgentPlannerAction =
  | { type: 'image.generate'; generation: GenerationPlan & { action: 'generate' } }
  | { type: 'image.edit'; generation: GenerationPlan & { action: 'edit' } }
  | { type: 'image.transform'; input: PlannerArtifactRef; transform: ImageTransform }
  | { type: 'metadata.assert'; input: PlannerArtifactRef; expected: FinalOutputSpec };

export interface OpenShopCropCommand {
  schemaVersion: 1;
  id: 'canvas.crop';
  target: 'document';
  args: { x: number; y: number; width: number; height: number };
}

export interface OpenShopRotateCommand {
  schemaVersion: 1;
  id: 'canvas.rotate';
  target: 'document';
  args: { degrees: 90 | -90 | 180 | -180 };
}

export interface OpenShopFlipCommand {
  schemaVersion: 1;
  id: 'canvas.flip';
  target: 'document';
  args: { axis: 'h' | 'v' };
}

export interface OpenShopFlattenCommand {
  schemaVersion: 1;
  id: 'canvas.flatten';
  target: 'document';
  args: Record<never, never>;
}

export type OpenShopCanvasCommand =
  | OpenShopCropCommand
  | OpenShopRotateCommand
  | OpenShopFlipCommand
  | OpenShopFlattenCommand;

export type ImageToolOperation =
  | { type: 'image.generate'; generation: GenerationPlan & { action: 'generate' } }
  | { type: 'image.edit'; generation: GenerationPlan & { action: 'edit' } };

export interface OpenShopEditOperation {
  type: 'openshop.edit';
  /** Gateway asset UUID。浏览器 IndexedDB ID 只存在于前端 binding，不进入计划。 */
  inputAssetId: string;
  commands: OpenShopCanvasCommand[];
  outputFormat: 'png';
}

export type ToolOperation = ImageToolOperation | OpenShopEditOperation;

export interface RestrictedAgentPlanSnapshotBase {
  id: string;
  version: number;
  status: PlanStatus;
  expiresAt: string;
  originalRequest: string;
  summary: string;
  inputs: PlanInputView[];
  assumptions: string[];
  warnings: string[];
  policyVersion: string;
  webSearch?: WebSearchReference;
}

export interface LegacyRestrictedAgentPlanSnapshot extends RestrictedAgentPlanSnapshotBase {
  schemaVersion?: never;
  composerSnapshotHash?: never;
  operation?: never;
  steps: PlanStep[];
  generation: GenerationPlan;
}

export interface ToolAgentPlanSnapshot extends RestrictedAgentPlanSnapshotBase {
  schemaVersion: 2;
  composerSnapshotHash: string;
  operation: ToolOperation;
  steps?: never;
  generation?: never;
  actions?: never;
}

/**
 * v3 仅描述受限的 Gateway action 链。它不能进入旧版单 operation
 * 执行入口；自动执行、action 持久化与 Worker 会在后续任务接入。
 */
export interface ToolAgentPlanV3Snapshot extends RestrictedAgentPlanSnapshotBase {
  schemaVersion: 3;
  composerSnapshotHash: string;
  finalOutputSpec: FinalOutputSpec | null;
  actions: ToolAction[];
  steps?: never;
  generation?: never;
  operation?: never;
}

export type RestrictedAgentPlanSnapshot =
  | LegacyRestrictedAgentPlanSnapshot
  | ToolAgentPlanSnapshot
  | ToolAgentPlanV3Snapshot;

export interface ExecutionAssetView {
  id: string;
  url: string;
  mimeType: string;
  sha256: string;
  width: number;
  height: number;
  byteSize: number;
}

/** v3 action 的不可变参数、执行状态及实际使用的输入/输出资产。 */
export interface ExecutionActionView {
  id: string;
  executionId: string;
  actionIndex: number;
  type: ToolAction['type'];
  normalizedParams: ToolAction;
  status: ExecutionActionStatus;
  idempotencyKey: string;
  error: { code: string; message: string } | null;
  inputAssets: ExecutionAssetView[];
  outputAssets: ExecutionAssetView[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface ExecutionActionInsert {
  id?: string;
  executionId: string;
  actionIndex: number;
  action: ToolAction;
  idempotencyKey?: string;
  status?: Extract<ExecutionActionStatus, 'queued' | 'executing'>;
}

export interface ExecutionView {
  id: string;
  planId: string;
  status: ExecutionStatus;
  cancelRequested: boolean;
  error: { code: string; message: string } | null;
  /** v1/v2 为全部已生成资产；v3 仅在 metadata.assert 完成后提供最终资产。 */
  outputAssets: ExecutionAssetView[];
  actions: ExecutionActionView[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface PlannerDraft {
  summary: string;
  operation:
    | ImageToolOperation
    | {
        type: 'openshop.edit';
        inputIndex: number;
        commands: OpenShopCanvasCommand[];
        outputFormat: 'png';
      };
  assumptions: string[];
  warnings: string[];
}

/** Planner 的 v3 输出；Gateway 策略会校验并规范化其变换与断言参数。 */
export interface ToolAgentPlannerDraft {
  summary: string;
  actions: ToolAgentPlannerAction[];
  assumptions: string[];
  warnings: string[];
}

/** 已完成白名单、顺序、引用与输出规格归一化的 v3 Planner 输出。 */
export interface ConstrainedToolAgentPlannerDraft {
  summary: string;
  actions: ToolAction[];
  finalOutputSpec: FinalOutputSpec;
  assumptions: string[];
  warnings: string[];
}

export interface ComposerSnapshotInput {
  browserImageId: string;
  contentSha256: string;
  role: Exclude<PlanInputRole, 'mask'>;
  ordinal: number;
}

export interface ComposerSnapshotManifest {
  schemaVersion: 2;
  scope: 'tool';
  prompt: string;
  inputs: ComposerSnapshotInput[];
  mask: {
    targetBrowserImageId: string;
    contentSha256: string;
  } | null;
  params: {
    size: string;
    quality: GenerationPlan['quality'];
    outputFormat: GenerationPlan['outputFormat'];
    outputCompression: number | null;
    moderation: 'auto' | 'low';
    imageCount: number;
  };
  temporaryProfile: {
    id: string | null;
    name: string | null;
    missing: boolean;
  };
}

export interface PlanPreferences {
  size?: string;
  quality?: GenerationPlan['quality'];
  outputFormat?: GenerationPlan['outputFormat'];
  outputCompression?: number;
  imageCount?: number;
}

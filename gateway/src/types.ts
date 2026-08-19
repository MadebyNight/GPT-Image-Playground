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

interface RestrictedAgentPlanSnapshotBase {
  id: string;
  version: number;
  status: PlanStatus;
  expiresAt: string;
  originalRequest: string;
  /** 新建计划始终存在；旧版已持久化计划兼容时可缺失。 */
  assistantMessage?: string;
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

export type RestrictedAgentPlanSnapshot = LegacyRestrictedAgentPlanSnapshot | ToolAgentPlanSnapshot;

export interface ExecutionView {
  id: string;
  planId: string;
  status: ExecutionStatus;
  cancelRequested: boolean;
  error: { code: string; message: string } | null;
  outputAssets: Array<{
    id: string;
    url: string;
    mimeType: string;
    sha256: string;
    width: number;
    height: number;
    byteSize: number;
  }>;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface PlannerDraft {
  assistantMessage: string;
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

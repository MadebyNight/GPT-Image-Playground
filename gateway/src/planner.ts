import { readFile } from 'node:fs/promises';
import type { GatewayConfig } from './config.js';
import { AppError } from './errors.js';
import { plannerJsonSchema } from './policy.js';
import type { PlanPreferences, PlannerDraft, StoredAsset } from './types.js';

export interface PlannerInput {
  request: string;
  preferences: PlanPreferences;
  assets: StoredAsset[];
  allowOpenShop: boolean;
}

export interface Planner {
  createDraft(input: PlannerInput): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeUpstreamText(value: unknown, maxLength = 500): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = value
    .replace(/\bBearer\s+[^\s,;，；。]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized) return undefined;
  return sanitized.slice(0, maxLength);
}

async function readUpstreamError(response: Response): Promise<{
  message?: string;
  details: Record<string, string | number>;
}> {
  const details: Record<string, string | number> = { upstreamStatus: response.status };
  let payload: unknown;
  try {
    const text = await response.text();
    if (!text) return { details };
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = { message: text };
    }
  } catch {
    return { details };
  }

  const root = isRecord(payload) ? payload : undefined;
  const upstreamError = root && isRecord(root.error) ? root.error : root;
  if (!upstreamError) return { details };
  const code = sanitizeUpstreamText(upstreamError.code, 100);
  const type = sanitizeUpstreamText(upstreamError.type, 100);
  const param = sanitizeUpstreamText(upstreamError.param, 200);
  const message = sanitizeUpstreamText(upstreamError.message);
  if (code) details.upstreamCode = code;
  if (type) details.upstreamType = type;
  if (param) details.upstreamParam = param;
  return { message, details };
}

function extractOutputText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  if (typeof root.output_text === 'string') return root.output_text;
  if (!Array.isArray(root.output)) return null;
  for (const item of root.output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === 'string') return text;
      const json = (part as Record<string, unknown>).json;
      if (json !== undefined) return JSON.stringify(json);
    }
  }
  return null;
}

export class ResponsesPlanner implements Planner {
  constructor(private readonly config: GatewayConfig) {}

  async createDraft(input: PlannerInput): Promise<unknown> {
    const content: Array<Record<string, unknown>> = [{
      type: 'input_text',
      text: [
        '你是一个受限图片工具计划器。只返回符合 schema 的单一 operation，不执行任何工具。',
        '精确描述最终图像，并把用户未明确说明但执行所必需的判断列入 assumptions。',
        '图片 API 只能选择 image.generate 或 image.edit，operation.type 必须与 generation.action 一致。',
        input.allowOpenShop
          ? '仅当用户明确要求裁剪、±90/±180 度旋转、水平/垂直翻转或扁平化，且只有一张普通参考图、没有 mask 时，才可选择 openshop.edit。inputIndex 是按输入顺序从 0 开始的索引；每次 1-5 条 command，只能使用 canvas.crop/canvas.rotate/canvas.flip/canvas.flatten、target=document，不得输出 objectId/layerId。canvas.crop 必须满足 width * height <= 80_000_000。'
          : '当前客户端不支持 OpenShop；只能选择 image.generate 或 image.edit。',
        `用户需求：${input.request}`,
        `用户偏好：${JSON.stringify(input.preferences)}`,
      ].join('\n'),
    }];

    for (const [index, asset] of input.assets.entries()) {
      const bytes = await readFile(asset.storagePath);
      content.push({
        type: 'input_image',
        image_url: `data:${asset.mimeType};base64,${bytes.toString('base64')}`,
        detail: 'high',
      });
      content.push({ type: 'input_text', text: `输入索引：${index}；受控角色：${asset.role}；SHA-256：${asset.sha256}` });
    }

    const signal = AbortSignal.timeout(this.config.plannerTimeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.config.upstreamBaseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.plannerModel,
          input: [{ role: 'user', content }],
          text: {
            format: {
              type: 'json_schema',
              name: 'single_tool_operation_plan',
              strict: true,
              schema: plannerJsonSchema,
            },
          },
        }),
        redirect: 'error',
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw new AppError(504, 'planner_timeout', 'Planner 请求超时');
      throw new AppError(502, 'planner_unavailable', 'Planner 无法连接');
    }
    if (!response.ok) {
      const upstreamError = await readUpstreamError(response);
      throw new AppError(
        502,
        'planner_upstream_error',
        `Planner 上游返回 HTTP ${response.status}${upstreamError.message ? `：${upstreamError.message}` : ''}`,
        upstreamError.details,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AppError(502, 'invalid_planner_response', 'Planner 返回了无效 JSON');
    }
    const outputText = extractOutputText(payload);
    if (!outputText) throw new AppError(502, 'missing_planner_output', 'Planner 未返回结构化计划');
    try {
      return JSON.parse(outputText) as PlannerDraft;
    } catch {
      throw new AppError(502, 'invalid_planner_output', 'Planner 计划不是有效 JSON');
    }
  }
}

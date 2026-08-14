import { z } from 'zod';
import { assertGatewayResponsesRoute } from './agentRoute.js';
import type { GatewayConfig } from './config.js';
import { AppError } from './errors.js';

const MAX_REQUEST_LENGTH = 16_000;
const MAX_INPUT_TEXT_LENGTH = 64_000;
const MAX_CONVERSATION_CONTEXT_LENGTH = 6_000;
const IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]*={0,2}$/iu;
const requestSchema = z.object({
  request: z.string().trim().min(1).max(MAX_REQUEST_LENGTH),
}).passthrough();

const imageToolSchema = z.object({
  type: z.literal('image_generation'),
  action: z.enum(['generate', 'edit']),
  size: z.string().trim().regex(/^(?:auto|\d{1,5}x\d{1,5})$/u).max(16),
  quality: z.enum(['auto', 'low', 'medium', 'high']).optional(),
  output_format: z.enum(['png', 'jpeg', 'webp']),
  output_compression: z.number().int().min(0).max(100).optional(),
  input_image_mask: z.object({
    image_url: z.string().min(1).regex(IMAGE_DATA_URL_RE),
  }).strict().optional(),
}).strict();

type ResponsesImageTool = z.infer<typeof imageToolSchema>;
type ResponsesInputContent = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string };
type ResponsesInputMessage = {
  role: 'user';
  content: ResponsesInputContent[];
};
type ResponsesInput = string | ResponsesInputMessage[];

export interface GuardedResponsesRequest {
  request: string;
  /** 已校验的本轮全部用户文本；relay 会再次用它 fail closed。 */
  routeText: string;
  upstreamBody: Record<string, unknown>;
}

/**
 * 将浏览器白名单请求编译成实际的 Responses 请求。客户端永远不能传入 model、
 * tools、tool_choice、上游地址或认证信息；imageTool 也会被重建而非直接透传。
 */
export function guardResponsesImageRequest(body: unknown, config: GatewayConfig): GuardedResponsesRequest {
  const routeInput = requestSchema.safeParse(body);
  if (!routeInput.success) {
    throw new AppError(400, 'invalid_responses_request', 'Responses 图片请求字段无效');
  }
  // 在完整 payload 校验前先拒绝 request 自身的硬约束，避免无效附带字段影响
  // 严格规格请求的 fail-closed 结论。
  assertGatewayResponsesRoute(routeInput.data.request);

  const parsed = createPayloadSchema(config).safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, 'invalid_responses_request', 'Responses 图片请求字段无效');
  }

  const { request, input, conversationContext, stream, imageTool } = parsed.data;
  const inputText = getInputText(input);
  if (!inputText.includes(request)) {
    throw new AppError(400, 'request_input_mismatch', 'Responses input 必须包含当前请求文本');
  }
  // `input` 可由多个本轮 input_text 段组成。必须聚合它们全部再路由，
  // 否则攻击者可在 request 中放普通请求、在额外文本中塞入严格尺寸或变换要求。
  const routeText = `${request}\n${inputText}`;
  assertGatewayResponsesRoute(routeText);

  const inputImageCount = getInputImageCount(input);
  if ((imageTool.action === 'edit') !== (inputImageCount > 0)) {
    throw new AppError(400, 'image_tool_input_mismatch', 'imageTool action 必须与输入图片一致');
  }
  // Responses 的 image_generation 只能保留模型自行选择的候选尺寸。客户端即使
  // 没有把尺寸写入文本，也不能通过 imageTool 参数绕开硬约束路由；任意具体像素
  // 尺寸必须交给 v3 Tool Pipeline 做最终 transform 与 metadata 校验。
  if (imageTool.size !== 'auto') {
    throw new AppError(
      409,
      'hard_constraint_requires_tool_pipeline',
      '精确像素尺寸必须通过 Tool Pipeline 生成并校验最终产物。',
      {
        route: 'tool_pipeline',
        routeReason: '检测到 imageTool 中的精确像素尺寸。',
        hardConstraints: ['精确像素尺寸'],
        fallbackForbidden: true,
      },
    );
  }
  if (imageTool.input_image_mask && imageTool.action !== 'edit') {
    throw new AppError(400, 'image_tool_mask_mismatch', '遮罩只能用于图片编辑');
  }
  if (imageTool.output_format === 'png' && imageTool.output_compression !== undefined) {
    throw new AppError(400, 'image_tool_compression_mismatch', 'PNG 不接受 output_compression');
  }

  return {
    request,
    routeText,
    upstreamBody: {
      // Responses 的 image_generation 是文本模型调用的内置工具；imageModel 仅用于
      // /images/generations 与 /images/edits，不能替代这里支持工具调用的模型。
      model: config.plannerModel,
      input: prependConversationContext(input, conversationContext),
      tools: [toFixedImageTool(imageTool)],
      tool_choice: 'required',
      ...(stream ? { stream: true } : {}),
    },
  };
}

/** 防御性地再次路由；调用方不能绕过 guardResponsesImageRequest 直接向上游转发。 */
export async function relayResponsesImage(request: GuardedResponsesRequest, config: GatewayConfig): Promise<Response> {
  assertGatewayResponsesRoute(request.routeText);
  const timeoutSignal = AbortSignal.timeout(config.executorTimeoutMs);
  try {
    return await fetch(`${config.upstreamBaseUrl}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request.upstreamBody),
      cache: 'no-store',
      redirect: 'error',
      signal: timeoutSignal,
    });
  } catch (error) {
    if (timeoutSignal.aborted || isTimeoutError(error)) {
      throw new AppError(504, 'responses_timeout', 'Responses 图片上游响应超时');
    }
    throw new AppError(502, 'responses_unavailable', 'Responses 上游无法连接');
  }
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'TimeoutError' || candidate.code === 'ETIMEDOUT';
}

function createPayloadSchema(config: GatewayConfig) {
  const imageDataUrl = z.string().max(config.maxUploadBytes).refine(
    (value) => IMAGE_DATA_URL_RE.test(value),
    'input image 必须是 PNG、JPEG 或 WebP data URL',
  );
  const inputContent = z.discriminatedUnion('type', [
    z.object({ type: z.literal('input_text'), text: z.string().trim().min(1).max(MAX_INPUT_TEXT_LENGTH) }).strict(),
    z.object({ type: z.literal('input_image'), image_url: imageDataUrl }).strict(),
  ]);
  const input = z.union([
    z.string().trim().min(1).max(MAX_INPUT_TEXT_LENGTH),
    z.array(z.object({
      role: z.literal('user'),
      content: z.array(inputContent).min(1).max(config.maxReferenceImages + 1),
    }).strict()).length(1),
  ]);
  return z.object({
    request: z.string().trim().min(1).max(MAX_REQUEST_LENGTH),
    input,
    // 这是已完成轮次的上下文，不属于当前请求；它只在服务端重新编排上游 input，
    // 因而不能用于绕过本轮 input_text 的聚合路由校验。
    conversationContext: z.string().trim().min(1).max(MAX_CONVERSATION_CONTEXT_LENGTH).optional(),
    stream: z.boolean().optional(),
    imageTool: imageToolSchema,
  }).strict();
}

/**
 * 历史会话由独立字段传入，避免与本轮 input_text 混为同一可路由请求。转发给
 * Responses 时仍以前序 user message 保留它，输入图片始终留在本轮消息中。
 */
function prependConversationContext(input: ResponsesInput, conversationContext: string | undefined): ResponsesInput {
  if (!conversationContext) return input;

  const contextMessage: ResponsesInputMessage = {
    role: 'user',
    content: [{ type: 'input_text', text: conversationContext }],
  };
  if (typeof input === 'string') {
    return [
      contextMessage,
      { role: 'user', content: [{ type: 'input_text', text: input }] },
    ];
  }
  return [contextMessage, ...input];
}

function getInputText(input: ResponsesInput): string {
  if (typeof input === 'string') return input;
  return input.flatMap((message) => message.content)
    .filter((content): content is { type: 'input_text'; text: string } => content.type === 'input_text')
    .map((content) => content.text)
    .join('\n');
}

function getInputImageCount(input: ResponsesInput): number {
  if (typeof input === 'string') return 0;
  return input.flatMap((message) => message.content).filter((content) => content.type === 'input_image').length;
}

function toFixedImageTool(tool: ResponsesImageTool): Record<string, unknown> {
  return {
    type: 'image_generation',
    action: tool.action,
    size: tool.size,
    ...(tool.quality ? { quality: tool.quality } : {}),
    output_format: tool.output_format,
    ...(tool.output_compression !== undefined ? { output_compression: tool.output_compression } : {}),
    ...(tool.input_image_mask ? { input_image_mask: { image_url: tool.input_image_mask.image_url } } : {}),
  };
}

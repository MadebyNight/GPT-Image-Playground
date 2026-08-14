import { AppError } from './errors.js';

export type GatewayAgentRoute = 'responses_image' | 'tool_pipeline' | 'clarify' | 'unsupported';

export interface GatewayAgentRouteDecision {
  route: GatewayAgentRoute;
  routeReason: string;
  hardConstraints: string[];
  fallbackForbidden: boolean;
}

const PIXEL_SIZE_RE = /(?<!\d)(\d{1,6})\s*(?:×|x|\*)\s*(\d{1,6})(?:\s*(?:px|像素))?(?!\d)/giu;
const NAMED_PIXEL_SIZE_RE = /宽(?:度)?\s*[=:：]?\s*(\d{1,6})\s*(?:px|像素)?\s*[,，;；\s]+高(?:度)?\s*[=:：]?\s*(\d{1,6})\s*(?:px|像素)?/giu;
const ASPECT_RATIO_RE = /(\d+(?:\.\d+)?)\s*(?:[:：]|比|\/)\s*(\d+(?:\.\d+)?)/gu;
const KNOWN_ASPECT_RATIOS = new Set(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9']);
const EXPLICIT_NAMED_TOOL_RE = /(?:请(?:你)?\s*)?(?:使用|用)\s*(?:(?:adobe\s+)?photoshop|illustrator|lightroom|gimp|figma|canva|procreate|krita|affinity(?:\s+photo)?|blender|comfyui|stable\s*diffusion|midjourney|dall[·-]?e|firefly|美图秀秀|醒图|可画|稿定设计)/iu;
const TRANSPARENCY_REQUIREMENT_RE = /透明(?:背景|底|通道)|背景透明|alpha(?:\s*通道)?|透明\s*(?:\b(?:png|webp)\b|图片|图像)|(?:输出|导出|保存|交付).{0,12}透明/iu;
const UNSUPPORTED_FORMAT_RE = /(?:\bgif\b|\.gif(?=\s|$|[，,。.!！?？]))|(?:\bsvg\b|\.svg(?=\s|$|[，,。.!！?？]))|(?:\bavif\b|\.avif(?=\s|$|[，,。.!！?？]))|(?:\btiff?\b|\.tiff?(?=\s|$|[，,。.!！?？]))|(?:\bbmp\b|\.bmp(?=\s|$|[，,。.!！?？]))/iu;
const OUTPUT_FORMAT_CONTEXT_RE = /输出|导出|保存|格式|format/iu;
// 与前端路由器保持相同的“编辑某张图片”语义，不能把“旋转木马”等画面描述
// 误认为确定性旋转操作。
const ROTATION_REQUEST_RE = /(?:顺时针|逆时针|clockwise|counterclockwise)\s*(?:旋转|转动)|(?:旋转|转动)\s*(?:为|到)?\s*-?\d+(?:\.\d+)?\s*(?:°|度|degrees?)|(?:旋转|转动)(?:这|该|图片|图像|照片|画面)|(?:把|将|让).{0,20}(?:图|图片|图像|照片|画面|它).{0,10}(?:旋转|转动)|\brotate\b/iu;

/**
 * Gateway 侧的最小同构路由守卫。这里刻意只识别会让 Responses 不能兑现交付
 * 结果的硬约束；更细的规格提取仍由浏览器路由器和 v3 Tool Pipeline 完成。
 */
export function routeGatewayAgentTurn(request: string): GatewayAgentRouteDecision {
  const prompt = request.trim();
  if (!prompt) return decision('clarify', '请描述想生成或编辑的图片。', []);

  const hardConstraints: string[] = [];
  const pixelSize = getPixelSizeState(prompt);
  if (pixelSize.invalid) {
    return decision('clarify', '像素尺寸必须是正整数，请重新说明宽和高。', ['无效像素尺寸']);
  }
  if (pixelSize.present) hardConstraints.push('精确像素尺寸');
  if (hasFixedAspectRatio(prompt) || /固定(?:画布|画面|画幅)|画布(?:大小|尺寸)|固定尺寸/iu.test(prompt)) {
    hardConstraints.push('固定比例或画布');
  }
  if (/不\s*(?:要|允许)?\s*(?:裁剪|裁切)|完整保留|保留完整(?:画面)?|\bcontain\b|允许\s*(?:变形|拉伸)|(?:可以|可)\s*(?:变形|拉伸)|\b(?:fill|stretch|cover)\b/iu.test(prompt)) {
    hardConstraints.push('尺寸适配策略');
  }
  if (/裁剪|裁切|剪裁|\bcrop\b/iu.test(prompt)) hardConstraints.push('裁剪');
  if (ROTATION_REQUEST_RE.test(prompt)) hardConstraints.push('旋转');
  if (/水平翻转|垂直翻转|左右翻转|上下翻转|翻转(?:一下)?|镜像|\bflip\b/iu.test(prompt)) hardConstraints.push('翻转');
  if (/缩放|缩小|放大(?!镜)|\b(?:resize|scale)\b/iu.test(prompt)) hardConstraints.push('缩放');
  if (/(?:\bpng\b|\.png(?=\s|$|[，,。.!！?？]))|(?:\bjpe?g\b|\.jpe?g(?=\s|$|[，,。.!！?？]))|(?:\bwebp\b|\.webp(?=\s|$|[，,。.!！?？]))/iu.test(prompt)) {
    hardConstraints.push('明确输出格式');
  }
  if (TRANSPARENCY_REQUIREMENT_RE.test(prompt)) {
    hardConstraints.push('透明背景');
  }
  if (/(?:压缩(?:质量|率|级别)?|compression|quality)\s*(?:为|到|:|：)?\s*\d{1,3}\s*%?/iu.test(prompt)) {
    hardConstraints.push('压缩质量');
  }
  if (/\btool\s*pipeline\b|工具链|\bgateway\b|网关|\bsharp\b|\bopenshop\b|(?:请|使用|用).{0,8}(?:工具|确定性处理|确定性编辑)/iu.test(prompt)
    || EXPLICIT_NAMED_TOOL_RE.test(prompt)) {
    hardConstraints.push('明确要求工具');
  }

  if (TRANSPARENCY_REQUIREMENT_RE.test(prompt)
    && /(?:\bjpeg\b|\bjpg\b|\.jpe?g(?=\s|$|[，,。.!！?？]))/iu.test(prompt)) {
    return decision('clarify', 'JPEG 不支持透明背景；请改用 PNG 或 WebP，或移除透明背景要求。', hardConstraints);
  }
  if (UNSUPPORTED_FORMAT_RE.test(prompt) && OUTPUT_FORMAT_CONTEXT_RE.test(prompt)) {
    return decision('unsupported', '当前严格图片工具链不支持所请求的输出格式。', hardConstraints);
  }
  if (hardConstraints.length > 0) {
    return decision(
      'tool_pipeline',
      `检测到严格输出或确定性编辑要求：${hardConstraints.join('、')}。`,
      hardConstraints,
    );
  }
  return decision('responses_image', '未检测到严格输出或确定性编辑要求，允许使用 Responses。', []);
}

/** 任何非 Responses 路由都必须在触达上游前失败关闭。 */
export function assertGatewayResponsesRoute(request: string): GatewayAgentRouteDecision {
  const route = routeGatewayAgentTurn(request);
  if (route.route !== 'responses_image') {
    throw new AppError(409, 'hard_constraint_requires_tool_pipeline', route.routeReason, route);
  }
  return route;
}

function getPixelSizeState(prompt: string): { present: boolean; invalid: boolean } {
  let present = false;
  let invalid = false;
  for (const match of prompt.matchAll(PIXEL_SIZE_RE)) {
    if (Number(match[1]) > 0 && Number(match[2]) > 0) present = true;
    else invalid = true;
  }
  for (const match of prompt.matchAll(NAMED_PIXEL_SIZE_RE)) {
    if (Number(match[1]) > 0 && Number(match[2]) > 0) present = true;
    else invalid = true;
  }
  return { present, invalid };
}

/** 与浏览器路由器同构：常见比例可直接识别，其他比例必须在比例/严格语境中出现。 */
function hasFixedAspectRatio(prompt: string): boolean {
  for (const match of prompt.matchAll(ASPECT_RATIO_RE)) {
    const width = match[1];
    const height = match[2];
    if (!width || !height) continue;
    const ratioText = `${trimRatioPart(width)}:${trimRatioPart(height)}`;
    const index = match.index ?? 0;
    const surrounding = prompt.slice(Math.max(0, index - 12), index + match[0].length + 12);
    if (/比例|宽高比|画幅|aspect|严格/iu.test(surrounding) || KNOWN_ASPECT_RATIOS.has(ratioText)) return true;
  }
  return false;
}

function trimRatioPart(value: string): string {
  return value.replace(/\.0+$/u, '');
}

function decision(
  route: GatewayAgentRoute,
  routeReason: string,
  hardConstraints: string[],
): GatewayAgentRouteDecision {
  return {
    route,
    routeReason,
    hardConstraints,
    fallbackForbidden: route !== 'responses_image',
  };
}

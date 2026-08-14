import type { AgentRouteDecision, FinalOutputSpec } from '../types'

/** 路由阶段可用的、不会隐式读取历史任务的输入快照。 */
export interface AgentRouteTurnInput {
  prompt: string
  /** 附件、结果卡“继续编辑”等已经建立的显式图片绑定。 */
  hasExplicitImageInput?: boolean
  /** 供调用方直接传入已绑定图片 ID；任一非空值都视为显式绑定。 */
  inputImageIds?: readonly string[]
}

type OutputFormat = NonNullable<FinalOutputSpec['outputFormat']>
type Rotation = NonNullable<FinalOutputSpec['rotate']>

interface PixelSize {
  width: number
  height: number
}

interface AspectRatio {
  width: number
  height: number
}

interface RotationParseResult {
  requested: boolean
  value: Rotation | null
  unsupported: boolean
}

interface FlipParseResult {
  requested: boolean
  value: NonNullable<FinalOutputSpec['flip']> | null
}

const PIXEL_SIZE_RE = /(?<!\d)(\d{1,6})\s*(?:×|x|\*)\s*(\d{1,6})(?:\s*(?:px|像素))?(?!\d)/giu
const NAMED_PIXEL_SIZE_RE = /宽(?:度)?\s*[=:：]?\s*(\d{1,6})\s*(?:px|像素)?\s*[,，;；\s]+高(?:度)?\s*[=:：]?\s*(\d{1,6})\s*(?:px|像素)?/giu
const ASPECT_RATIO_RE = /(\d+(?:\.\d+)?)\s*(?:[:：]|比|\/)\s*(\d+(?:\.\d+)?)/gu

const FORMAT_LABELS: Record<OutputFormat, string> = {
  png: 'PNG 格式',
  jpeg: 'JPEG 格式',
  webp: 'WebP 格式',
}

const SUPPORTED_FORMATS: Array<[OutputFormat, RegExp]> = [
  ['png', /(?:\bpng\b|\.png(?=\s|$|[，,。.!！?？]))/iu],
  ['jpeg', /(?:\bjpe?g\b|\.jpe?g(?=\s|$|[，,。.!！?？]))/iu],
  ['webp', /(?:\bwebp\b|\.webp(?=\s|$|[，,。.!！?？]))/iu],
]

const UNSUPPORTED_FORMATS: Array<[string, RegExp]> = [
  ['GIF', /(?:\bgif\b|\.gif(?=\s|$|[，,。.!！?？]))/iu],
  ['SVG', /(?:\bsvg\b|\.svg(?=\s|$|[，,。.!！?？]))/iu],
  ['AVIF', /(?:\bavif\b|\.avif(?=\s|$|[，,。.!！?？]))/iu],
  ['TIFF', /(?:\btiff?\b|\.tiff?(?=\s|$|[，,。.!！?？]))/iu],
  ['BMP', /(?:\bbmp\b|\.bmp(?=\s|$|[，,。.!！?？]))/iu],
]

const KNOWN_ASPECT_RATIOS = new Set(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'])

/**
 * 规则优先的路由器。它只根据当前回合的文本和显式输入作决策，绝不把历史图片
 * 当作 API 输入。硬约束一旦命中就不会返回 Responses 路径。
 */
export function routeAgentTurn(input: AgentRouteTurnInput): AgentRouteDecision {
  const prompt = input.prompt.trim()
  if (!prompt) {
    return decision('clarify', '请描述想生成或编辑的图片。', [], null)
  }

  const hardConstraints: string[] = []
  const outputSpec: FinalOutputSpec = {}
  const pixelSizes = getPixelSizes(prompt)
  const aspectRatios = getAspectRatios(prompt)
  const fitPreferences = getFitPreferences(prompt)
  const requestedPosition = getPosition(prompt)
  const crop = getCrop(prompt)
  const rotation = getRotation(prompt)
  const flip = getFlip(prompt)
  const scaleRequested = /缩放|缩小|放大|\b(?:resize|scale)\b/iu.test(prompt)
  const outputFormats = getOutputFormats(prompt)
  const unsupportedFormat = getUnsupportedOutputFormat(prompt)
  const transparent = /透明(?:背景|底|通道)?|背景透明|alpha(?:\s*通道)?/iu.test(prompt)
  const compression = getCompression(prompt)
  const explicitTool = getExplicitToolRequirement(prompt)

  if (pixelSizes.invalid) {
    return decision('clarify', '像素尺寸必须是正整数，请重新说明宽和高。', ['无效像素尺寸'], null)
  }
  if (pixelSizes.values.length > 1) {
    return decision('clarify', '检测到多个不同的目标尺寸，请明确最终应输出哪一个尺寸。', ['多个不同的像素尺寸'], null)
  }
  if (aspectRatios.invalid) {
    return decision('clarify', '比例的两个值都必须大于 0，请重新说明目标比例。', ['无效固定比例'], null)
  }
  if (aspectRatios.values.length > 1) {
    return decision('clarify', '检测到多个不同的固定比例，请明确最终应采用哪一个比例。', ['多个不同的固定比例'], null)
  }
  if (fitPreferences.conflict) {
    return decision('clarify', '“不裁切”和“允许变形”不能同时使用，请选择一种输出策略。', ['冲突的尺寸适配策略'], null)
  }
  if (outputFormats.length > 1) {
    return decision('clarify', '检测到多个输出格式，请明确最终只需一种格式。', outputFormats.map((format) => FORMAT_LABELS[format]), null)
  }
  if (compression.invalid) {
    return decision('clarify', '压缩质量必须是 0 到 100 之间的整数，请重新说明。', ['无效压缩质量'], null)
  }

  const pixelSize = pixelSizes.values[0]
  if (pixelSize) {
    pushConstraint(hardConstraints, `精确尺寸 ${pixelSize.width}×${pixelSize.height}px`)
    outputSpec.width = pixelSize.width
    outputSpec.height = pixelSize.height
    outputSpec.fit = fitPreferences.fit ?? 'cover'
    outputSpec.position = requestedPosition ?? 'center'
  }

  const aspectRatio = aspectRatios.values[0]
  if (aspectRatio) {
    pushConstraint(hardConstraints, `固定比例 ${formatRatio(aspectRatio)}`)
  }

  if (fitPreferences.fit && !pixelSize) {
    pushConstraint(hardConstraints, fitPreferences.fit === 'contain' ? '不裁切' : fitPreferences.fit === 'fill' ? '允许变形' : '填满画布')
    outputSpec.fit = fitPreferences.fit
    outputSpec.position = requestedPosition ?? 'center'
  }

  if (crop.requested) {
    pushConstraint(hardConstraints, '裁剪')
    if (crop.value) outputSpec.crop = crop.value
  }

  if (rotation.requested) {
    pushConstraint(hardConstraints, '旋转')
    if (rotation.value) outputSpec.rotate = rotation.value
  }

  if (flip.requested) {
    pushConstraint(hardConstraints, flip.value === 'horizontal' ? '水平翻转' : flip.value === 'vertical' ? '垂直翻转' : '翻转')
    if (flip.value) outputSpec.flip = flip.value
  }

  if (scaleRequested) pushConstraint(hardConstraints, '缩放')

  const outputFormat = outputFormats[0]
  if (outputFormat) {
    pushConstraint(hardConstraints, FORMAT_LABELS[outputFormat])
    outputSpec.outputFormat = outputFormat
  }

  if (transparent) {
    pushConstraint(hardConstraints, '透明背景')
    outputSpec.transparent = true
  }

  if (compression.value != null) {
    pushConstraint(hardConstraints, `压缩质量 ${compression.value}`)
    outputSpec.outputCompression = compression.value
  }

  if (explicitTool) pushConstraint(hardConstraints, explicitTool)

  if (transparent && outputFormat === 'jpeg') {
    return decision(
      'clarify',
      'JPEG 不支持透明背景；请改用 PNG 或 WebP，或移除透明背景要求。',
      hardConstraints,
      null,
    )
  }

  if (unsupportedFormat) {
    pushConstraint(hardConstraints, `${unsupportedFormat} 格式`)
    return decision(
      'unsupported',
      `${unsupportedFormat} 不是当前严格图片工具链支持的输出格式。`,
      hardConstraints,
      null,
    )
  }

  if (rotation.unsupported) {
    return decision(
      'unsupported',
      '当前严格图片工具链只接受 90°、-90°、180° 或 -180° 的旋转。',
      hardConstraints,
      null,
    )
  }

  if (rotation.requested && !rotation.value) {
    return decision('clarify', '请明确旋转方向和角度，例如“顺时针旋转 90°”。', hardConstraints, null)
  }

  if (flip.requested && !flip.value) {
    return decision('clarify', '请明确要水平翻转还是垂直翻转。', hardConstraints, null)
  }

  if (hasUnboundHistoricImageReference(prompt) && !hasExplicitImageBinding(input, prompt)) {
    return decision(
      'clarify',
      '历史图片尚未显式绑定；请通过附件、@图片或结果卡选择要编辑的图片。',
      hardConstraints,
      getFinalOutputSpec(outputSpec),
    )
  }

  const finalOutputSpec = getFinalOutputSpec(outputSpec)
  if (hardConstraints.length > 0) {
    return decision(
      'tool_pipeline',
      `检测到严格输出或确定性编辑要求：${hardConstraints.join('、')}。`,
      hardConstraints,
      finalOutputSpec,
    )
  }

  return decision(
    'responses_image',
    '未检测到严格输出或确定性编辑要求，使用支持流式输出和 partial image 的 Responses。',
    [],
    null,
  )
}

function decision(
  route: AgentRouteDecision['route'],
  routeReason: string,
  hardConstraints: string[],
  finalOutputSpec: FinalOutputSpec | null,
): AgentRouteDecision {
  return {
    route,
    routeReason,
    hardConstraints,
    fallbackForbidden: route !== 'responses_image',
    finalOutputSpec,
  }
}

function getPixelSizes(prompt: string): { values: PixelSize[]; invalid: boolean } {
  const values: PixelSize[] = []
  let invalid = false

  for (const match of prompt.matchAll(PIXEL_SIZE_RE)) {
    const width = Number(match[1])
    const height = Number(match[2])
    if (width <= 0 || height <= 0) {
      invalid = true
      continue
    }
    addPixelSize(values, { width, height })
  }

  for (const match of prompt.matchAll(NAMED_PIXEL_SIZE_RE)) {
    const width = Number(match[1])
    const height = Number(match[2])
    if (width <= 0 || height <= 0) {
      invalid = true
      continue
    }
    addPixelSize(values, { width, height })
  }

  return { values, invalid }
}

function addPixelSize(values: PixelSize[], next: PixelSize) {
  if (!values.some((value) => value.width === next.width && value.height === next.height)) values.push(next)
}

function getAspectRatios(prompt: string): { values: AspectRatio[]; invalid: boolean } {
  const values: AspectRatio[] = []
  let invalid = false

  for (const match of prompt.matchAll(ASPECT_RATIO_RE)) {
    const width = Number(match[1])
    const height = Number(match[2])
    const ratioText = `${trimRatioPart(match[1])}:${trimRatioPart(match[2])}`
    const surrounding = prompt.slice(Math.max(0, (match.index ?? 0) - 12), (match.index ?? 0) + match[0].length + 12)
    const hasRatioContext = /比例|宽高比|画幅|aspect|严格/iu.test(surrounding)

    if (!hasRatioContext && !KNOWN_ASPECT_RATIOS.has(ratioText)) continue
    if (width <= 0 || height <= 0) {
      invalid = true
      continue
    }
    if (!values.some((value) => value.width === width && value.height === height)) values.push({ width, height })
  }

  return { values, invalid }
}

function trimRatioPart(value: string) {
  return value.replace(/\.0+$/u, '')
}

function formatRatio(value: AspectRatio) {
  return `${trimRatioPart(String(value.width))}:${trimRatioPart(String(value.height))}`
}

function getFitPreferences(prompt: string): { fit: FinalOutputSpec['fit'] | null; conflict: boolean } {
  const contain = /不\s*(?:要|允许)?\s*(?:裁剪|裁切)|完整保留|保留完整(?:画面)?|\bcontain\b/iu.test(prompt)
  const fill = /允许\s*(?:变形|拉伸)|(?:可以|可)\s*(?:变形|拉伸)|\b(?:fill|stretch)\b/iu.test(prompt)
  const cover = /裁切\s*(?:以)?填满|填满(?:画布|目标尺寸)?|铺满|\bcover\b/iu.test(prompt)
  const requested = [contain ? 'contain' : null, fill ? 'fill' : null, cover ? 'cover' : null].filter(
    (value): value is NonNullable<FinalOutputSpec['fit']> => value != null,
  )

  return {
    fit: requested[0] ?? null,
    conflict: requested.length > 1,
  }
}

function getPosition(prompt: string): FinalOutputSpec['position'] | null {
  if (/(?:靠右|右对齐|\bright\b|(?:主体|人物|物体|画面|内容).{0,8}(?:在|靠|放在|置于)?右(?:侧|边)?)/iu.test(prompt)) return 'right'
  if (/(?:靠左|左对齐|\bleft\b|(?:主体|人物|物体|画面|内容).{0,8}(?:在|靠|放在|置于)?左(?:侧|边)?)/iu.test(prompt)) return 'left'
  if (/(?:靠上|顶部对齐|\btop\b|(?:主体|人物|物体|画面|内容).{0,8}(?:在|靠|放在|置于)?顶(?:部)?)/iu.test(prompt)) return 'top'
  if (/(?:靠下|底部对齐|\bbottom\b|(?:主体|人物|物体|画面|内容).{0,8}(?:在|靠|放在|置于)?底(?:部)?)/iu.test(prompt)) return 'bottom'
  if (/(?:居中|置中|中心对齐|\bcenter\b)/iu.test(prompt)) return 'center'
  return null
}

function getCrop(prompt: string): { requested: boolean; value: FinalOutputSpec['crop'] | null } {
  const requested = /裁剪|裁切|剪裁|\bcrop\b/iu.test(prompt)
  if (!requested) return { requested: false, value: null }

  const match = prompt.match(
    /(?:裁剪(?:区域)?|裁切(?:区域)?|剪裁(?:区域)?|crop)\s*(?:为|:|：)?\s*x\s*[=:：]\s*(\d+)\s*[,，]\s*y\s*[=:：]\s*(\d+)\s*[,，]\s*(?:width|宽)\s*[=:：]\s*(\d+)\s*[,，]\s*(?:height|高)\s*[=:：]\s*(\d+)/iu,
  )
  if (!match) return { requested: true, value: null }

  const crop = {
    x: Number(match[1]),
    y: Number(match[2]),
    width: Number(match[3]),
    height: Number(match[4]),
  }
  if (crop.width <= 0 || crop.height <= 0) return { requested: true, value: null }
  return { requested: true, value: crop }
}

function getRotation(prompt: string): RotationParseResult {
  const requested = /旋转|转动|\brotate\b/iu.test(prompt)
  if (!requested) return { requested: false, value: null, unsupported: false }

  const beforeDirection = prompt.match(
    /(?:(顺时针|逆时针|clockwise|counterclockwise)\s*)?(?:旋转|转动|rotate)\s*(?:为|到)?\s*(-?\d+(?:\.\d+)?)\s*(?:°|度|degrees?)/iu,
  )
  const afterDirection = beforeDirection
    ? null
    : prompt.match(
      /(?:旋转|转动|rotate)\s*(?:为|到)?\s*(-?\d+(?:\.\d+)?)\s*(?:°|度|degrees?)\s*(顺时针|逆时针|clockwise|counterclockwise)?/iu,
    )
  const match = beforeDirection ?? afterDirection
  if (!match) return { requested: true, value: null, unsupported: false }

  const direction = beforeDirection ? beforeDirection[1] : afterDirection?.[2]
  const degrees = Number(beforeDirection ? beforeDirection[2] : afterDirection?.[1])
  if (!Number.isInteger(degrees)) return { requested: true, value: null, unsupported: true }

  const signedDegrees = /逆时针|counterclockwise/iu.test(direction ?? '') ? -degrees : degrees
  const normalized = normalizeRotation(signedDegrees)
  if (normalized === 90 || normalized === -90 || normalized === 180 || normalized === -180) {
    return { requested: true, value: normalized, unsupported: false }
  }
  return { requested: true, value: null, unsupported: true }
}

function normalizeRotation(degrees: number): number {
  const remainder = degrees % 360
  if (remainder > 180) return remainder - 360
  if (remainder < -180) return remainder + 360
  return remainder
}

function getFlip(prompt: string): FlipParseResult {
  const requested = /翻转|镜像|\bflip\b/iu.test(prompt)
  if (!requested) return { requested: false, value: null }
  if (/水平翻转|左右翻转|镜像|\bhorizontal\s+flip\b|\bflip\s+horizontal\b/iu.test(prompt)) {
    return { requested: true, value: 'horizontal' }
  }
  if (/垂直翻转|上下翻转|\bvertical\s+flip\b|\bflip\s+vertical\b/iu.test(prompt)) {
    return { requested: true, value: 'vertical' }
  }
  return { requested: true, value: null }
}

function getOutputFormats(prompt: string): OutputFormat[] {
  return SUPPORTED_FORMATS.filter(([, pattern]) => pattern.test(prompt)).map(([format]) => format)
}

function getUnsupportedOutputFormat(prompt: string): string | null {
  for (const [format, pattern] of UNSUPPORTED_FORMATS) {
    if (pattern.test(prompt) && /输出|导出|保存|格式|format/iu.test(prompt)) return format
  }
  return null
}

function getCompression(prompt: string): { value: number | null; invalid: boolean } {
  const match = prompt.match(/(?:压缩(?:质量|率|级别)?|compression|quality)\s*(?:为|到|:|：)?\s*(\d{1,3})\s*%?/iu)
  if (!match) return { value: null, invalid: false }
  const value = Number(match[1])
  if (value < 0 || value > 100) return { value: null, invalid: true }
  return { value, invalid: false }
}

function getExplicitToolRequirement(prompt: string): string | null {
  if (/\btool\s*pipeline\b|工具链/iu.test(prompt)) return '明确要求 Tool Pipeline'
  if (/\bgateway\b|网关/iu.test(prompt)) return '明确要求 Gateway'
  if (/\bsharp\b/iu.test(prompt)) return '明确要求 Sharp'
  if (/\bopenshop\b/iu.test(prompt)) return '明确要求 OpenShop'
  if (/(?:请|使用|用).{0,8}(?:工具|确定性处理|确定性编辑)/u.test(prompt)) return '明确要求工具'
  return null
}

function hasExplicitImageBinding(input: AgentRouteTurnInput, prompt: string): boolean {
  if (input.hasExplicitImageInput) return true
  if (input.inputImageIds?.some((imageId) => imageId.trim().length > 0)) return true
  return /(?:\u2063)?@图\d+(?:\u2064)?/u.test(prompt)
    || /@\s*(?:图片|图像|image)/iu.test(prompt)
}

function hasUnboundHistoricImageReference(prompt: string): boolean {
  return /上一张(?:图|图片|照片)?|上张(?:图|图片|照片)?|前一张(?:图|图片|照片)?|前面的?(?:图|图片|照片)?|之前的?(?:图|图片|照片)?|刚才(?:的|那张)?(?:图|图片|照片)?|刚刚(?:的|那张)?(?:图|图片|照片)?|刚生成的?(?:图|图片|照片)?|上一次(?:生成)?的?(?:图|图片|照片)?/u.test(prompt)
}

function getFinalOutputSpec(outputSpec: FinalOutputSpec): FinalOutputSpec | null {
  return Object.keys(outputSpec).length > 0 ? outputSpec : null
}

function pushConstraint(constraints: string[], constraint: string) {
  if (!constraints.includes(constraint)) constraints.push(constraint)
}

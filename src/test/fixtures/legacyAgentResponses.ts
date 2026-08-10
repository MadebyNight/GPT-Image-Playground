export const LEGACY_AGENT_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgQIAff1fSAAAAABJRU5ErkJggg=='

export const LEGACY_AGENT_PROMPT = '生成 Chromium 基线图片'
export const LEGACY_AGENT_ASSISTANT_TEXT = 'Chromium 基线已完成。'

export const LEGACY_AGENT_COMPLETED_RESPONSE = {
  output: [
    {
      type: 'message',
      content: [{ type: 'output_text', text: LEGACY_AGENT_ASSISTANT_TEXT }],
    },
    {
      type: 'image_generation_call',
      result: LEGACY_AGENT_IMAGE_BASE64,
      revised_prompt: '一张用于 Chromium 基线验证的单像素图片',
    },
  ],
} as const

export const LEGACY_AGENT_REQUEST_BODY_FIXTURE = {
  model: 'gpt-5.5',
  input: LEGACY_AGENT_PROMPT,
  tools: [{
    type: 'image_generation',
    action: 'generate',
    size: 'auto',
    output_format: 'png',
    quality: 'auto',
  }],
  tool_choice: 'required',
  stream: true,
} as const

export const LEGACY_AGENT_STREAM_EVENTS = [
  { type: 'response.output_text.delta', delta: 'Chromium ' },
  { type: 'response.output_text.delta', delta: '基线已完成。' },
  { type: 'response.image_generation_call.in_progress' },
  {
    type: 'response.image_generation_call.partial_image',
    partial_image_b64: LEGACY_AGENT_IMAGE_BASE64,
  },
  { type: 'response.image_generation_call.completed' },
  { type: 'response.completed', response: LEGACY_AGENT_COMPLETED_RESPONSE },
] as const

export function createLegacyAgentSseFixture(): string {
  return [
    ...LEGACY_AGENT_STREAM_EVENTS.map((event) => `data: ${JSON.stringify(event)}\n\n`),
    'data: [DONE]\n\n',
  ].join('')
}

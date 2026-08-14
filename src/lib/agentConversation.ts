import type { AgentMode, TaskRecord } from '../types'

export const AGENT_CONTEXT_MAX_TURNS = 4
export const AGENT_CONTEXT_MAX_CHARACTERS = 6_000

const LEGACY_CONVERSATION_PREFIX = 'legacy-agent:'
const LEGACY_RESTRICTED_AGENT_CONVERSATION_PREFIX = 'legacy-restricted-agent:'
const LEGACY_OPENSHOP_CONVERSATION_PREFIX = 'legacy-openshop:'
const CONTEXT_INTRO = '你正在延续同一位用户的图像创作对话。以下仅是已完成轮次的上下文，用于理解连续修改；不要复述它，优先完成本轮请求。'

function truncateText(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value
  if (maxCharacters <= 1) return '…'.slice(0, maxCharacters)

  const leadingCharacters = Math.ceil((maxCharacters - 1) * 0.65)
  const trailingCharacters = maxCharacters - 1 - leadingCharacters
  const trailingText = trailingCharacters > 0 ? value.slice(-trailingCharacters) : ''
  return `${value.slice(0, leadingCharacters)}…${trailingText}`
}

function getAssistantContext(task: TaskRecord): string {
  const assistantText = task.agentAssistantText?.trim()
  if (assistantText) return assistantText

  const revisedPrompt = Object.values(task.revisedPromptByImage ?? {}).find((value) => value.trim())?.trim()
  if (revisedPrompt) return `工具采用的提示词：${revisedPrompt}`

  if (task.outputImages.length) return `已生成 ${task.outputImages.length} 张图片。`
  return '本轮已完成。'
}

function createContextBlock(task: TaskRecord, turn: number, maxCharacters: number): string | null {
  const prefix = `第 ${turn} 轮\n用户：`
  const separator = '\nAgent：'
  const userPrompt = task.prompt.trim() || '(未提供文字需求)'
  const assistantText = getAssistantContext(task)
  const fixedCharacters = prefix.length + separator.length
  if (maxCharacters <= fixedCharacters + 2) return null

  const contentBudget = maxCharacters - fixedCharacters
  const userBudget = Math.max(1, Math.floor(contentBudget * 0.42))
  const assistantBudget = Math.max(1, contentBudget - userBudget)
  return `${prefix}${truncateText(userPrompt, userBudget)}${separator}${truncateText(assistantText, assistantBudget)}`
}

/**
 * 为没有会话元数据的旧任务提供稳定且隔离的兼容会话。
 */
export function getAgentConversationId(task: TaskRecord): string {
  if (task.origin === 'restricted-agent') return `${LEGACY_RESTRICTED_AGENT_CONVERSATION_PREFIX}${task.id}`
  if (task.origin === 'openshop') return `${LEGACY_OPENSHOP_CONVERSATION_PREFIX}${task.id}`
  return task.agentConversationId?.trim() || `${LEGACY_CONVERSATION_PREFIX}${task.id}`
}

export function createAgentConversationId(): string {
  const randomPart = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `agent-${randomPart}`
}

export function getAgentModeForTask(task: TaskRecord): AgentMode | null {
  if (task.origin === 'agent') return 'chat'
  if (task.origin === 'restricted-agent') return 'tool'
  return null
}

export function filterAgentTasksByMode(tasks: TaskRecord[], mode: AgentMode): TaskRecord[] {
  return tasks.filter((task) => getAgentModeForTask(task) === mode)
}

function isAgentConversationTask(task: TaskRecord): boolean {
  return task.origin === 'agent' || task.origin === 'restricted-agent' || task.origin === 'openshop'
}

export function getConversationTasks(tasks: TaskRecord[], anchor: TaskRecord | string): TaskRecord[] {
  const conversationId = typeof anchor === 'string' ? anchor : getAgentConversationId(anchor)
  return tasks
    .filter((task) => isAgentConversationTask(task) && getAgentConversationId(task) === conversationId)
    .sort((a, b) => {
      const aTurn = a.agentTurn
      const bTurn = b.agentTurn
      if (aTurn !== undefined && bTurn !== undefined && aTurn !== bTurn) return aTurn - bTurn
      if (aTurn !== undefined && bTurn === undefined) return -1
      if (aTurn === undefined && bTurn !== undefined) return 1
      return a.createdAt - b.createdAt || a.id.localeCompare(b.id)
    })
}

/**
 * 将本地任务历史整理为有限长度的纯文本上下文。图片不会被隐式再次上传，
 * 以免一次普通追问意外增加请求体、成本或隐私暴露。
 */
export function buildAgentConversationContext(tasks: TaskRecord[], conversationId: string): string | null {
  const completedTurns = getConversationTasks(tasks, conversationId)
    // error 任务可以持久化流式 partial，供刷新后展示；但它不是完整回复，
    // 不能进入后续请求上下文，也不能被重试误认为成功轮次。
    .filter((task) => task.status === 'done')
    .slice(-AGENT_CONTEXT_MAX_TURNS)

  if (!completedTurns.length) return null

  // 预留引言与正文之间的两个换行，保证最终字符串不依赖二次截断也不超预算。
  let remainingCharacters = AGENT_CONTEXT_MAX_CHARACTERS - CONTEXT_INTRO.length - 2
  const blocks: string[] = []

  for (const task of [...completedTurns].reverse()) {
    if (remainingCharacters <= 0) break
    const turn = task.agentTurn ?? completedTurns.indexOf(task) + 1
    const separatorLength = blocks.length ? 2 : 0
    const availableCharacters = remainingCharacters - separatorLength
    if (availableCharacters <= 0) break

    const block = createContextBlock(task, turn, availableCharacters)
    if (!block) break
    blocks.unshift(block)
    remainingCharacters -= block.length + separatorLength
  }

  const context = `${CONTEXT_INTRO}\n\n${blocks.join('\n\n')}`
  return truncateText(context, AGENT_CONTEXT_MAX_CHARACTERS)
}

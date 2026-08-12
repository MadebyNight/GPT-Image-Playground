import {
  Children,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from 'react'
import { ArrowDownIcon } from './icons'

export const AGENT_CONVERSATION_BOTTOM_THRESHOLD = 96

interface AgentConversationScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export function isNearAgentConversationBottom(
  metrics: AgentConversationScrollMetrics,
  threshold = AGENT_CONVERSATION_BOTTOM_THRESHOLD,
) {
  const distanceFromBottom = Math.max(
    0,
    metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop,
  )

  return distanceFromBottom <= threshold
}

export interface AgentConversationStreamProps {
  children?: ReactNode
  conversationKey?: string | number | null
  contentVersion?: string | number
  emptyState?: ReactNode
  className?: string
}

function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter(Boolean).join(' ')
}

function scrollToLatest(
  element: HTMLDivElement,
  behavior: ScrollBehavior = 'auto',
) {
  if (behavior === 'auto') {
    element.scrollTop = element.scrollHeight
    return
  }

  element.scrollTo({ top: element.scrollHeight, behavior })
}

export default function AgentConversationStream({
  children,
  conversationKey,
  contentVersion,
  emptyState,
  className,
}: AgentConversationStreamProps) {
  const scrollRegionRef = useRef<HTMLDivElement>(null)
  const shouldFollowRef = useRef(true)
  const previousConversationKeyRef = useRef(conversationKey)
  const [showReturnToBottom, setShowReturnToBottom] = useState(false)
  const hasMessages = Children.count(children) > 0

  const updateFollowState = useCallback((element: HTMLDivElement) => {
    const isNearBottom = isNearAgentConversationBottom(element)
    shouldFollowRef.current = isNearBottom
    setShowReturnToBottom(!isNearBottom)
  }, [])

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    updateFollowState(event.currentTarget)
  }, [updateFollowState])

  const handleReturnToBottom = useCallback(() => {
    const scrollRegion = scrollRegionRef.current
    if (!scrollRegion) return

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    shouldFollowRef.current = true
    setShowReturnToBottom(false)
    scrollToLatest(scrollRegion, reduceMotion ? 'auto' : 'smooth')
  }, [])

  useLayoutEffect(() => {
    const scrollRegion = scrollRegionRef.current
    if (!scrollRegion) return

    const conversationChanged = previousConversationKeyRef.current !== conversationKey
    previousConversationKeyRef.current = conversationKey

    if (conversationChanged) {
      shouldFollowRef.current = true
    }

    if (conversationChanged || shouldFollowRef.current) {
      scrollToLatest(scrollRegion)
      setShowReturnToBottom(false)
    }
  }, [children, contentVersion, conversationKey])

  return (
    <section
      data-agent-conversation-stream
      className={joinClassNames('relative min-h-0 flex-1', className)}
    >
      <div
        ref={scrollRegionRef}
        data-agent-conversation-scroll-region
        role="region"
        aria-label="对话消息"
        tabIndex={0}
        onScroll={handleScroll}
        className="h-full overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col px-[clamp(16px,5vw,72px)] py-8">
          {hasMessages ? children : emptyState}
        </div>
      </div>

      <button
        type="button"
        data-agent-conversation-return-to-bottom
        hidden={!showReturnToBottom}
        aria-label="回到底部"
        title="回到底部"
        onClick={handleReturnToBottom}
        className={joinClassNames(
          'absolute bottom-4 left-1/2 min-h-11 -translate-x-1/2 items-center gap-2 rounded-full border border-slate-200/80 bg-white/95 px-4 py-2 text-sm font-medium text-slate-700 shadow-lg backdrop-blur transition hover:border-slate-300 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 motion-reduce:transition-none dark:border-slate-700 dark:bg-slate-900/95 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:text-white',
          showReturnToBottom ? 'inline-flex' : 'hidden',
        )}
      >
        <ArrowDownIcon aria-hidden="true" className="h-4 w-4" />
        回到底部
      </button>
    </section>
  )
}

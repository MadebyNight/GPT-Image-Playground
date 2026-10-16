import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDownIcon } from './icons'
import type { ApiMode } from '../types'
import { resolveModelAvailability } from '../lib/modelCatalog'

interface ModelComboboxProps {
  value: string
  options: string[]
  onChange: (model: string) => void
  onBlur?: (model: string) => void
  onSelect: (model: string, mode: ApiMode) => void
  loadModels: (signal: AbortSignal) => Promise<string[]>
  protocols?: Record<string, ApiMode> | null
  allowCustomModel?: boolean
  allowedModes?: ApiMode[]
}

export default function ModelCombobox({ value, options, onChange, onBlur, onSelect, loadModels, protocols = null, allowCustomModel = true, allowedModes = ['images', 'responses'] }: ModelComboboxProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [models, setModels] = useState(options)
  const [status, setStatus] = useState<'idle' | 'loading' | 'failed' | 'ready'>('idle')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const listId = useId()

  const openList = () => {
    if (isOpen) return
    setStatus('loading')
    setIsOpen(true)
  }

  const focusSelectableOption = (start: number, direction: number) => {
    for (let offset = 0; offset < models.length; offset++) {
      const index = (start + direction * offset + models.length) % models.length
      const option = optionRefs.current[index]
      if (option && !option.disabled) {
        option.focus()
        return
      }
    }
  }

  useEffect(() => {
    if (!isOpen) return
    const controller = new AbortController()
    setStatus('loading')
    loadModels(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setModels(result)
      setStatus('ready')
    }).catch(() => {
      if (controller.signal.aborted) return
      setModels(options)
      setStatus('failed')
    })
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    return () => {
      controller.abort()
      document.removeEventListener('pointerdown', closeOnOutsideClick)
    }
  }, [isOpen])

  return (
    <div ref={containerRef} className="relative">
      <div className="flex w-full rounded-lg border border-blue-100 bg-white/80 text-xs text-gray-700 transition focus-within:border-blue-300 focus-within:ring-2 focus-within:ring-blue-500/20 dark:border-blue-500/20 dark:bg-white/[0.04] dark:text-gray-100">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={(event) => onBlur?.(event.target.value)}
          readOnly={!allowCustomModel}
          onFocus={openList}
          onClick={openList}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && isOpen) {
              event.stopPropagation()
              setIsOpen(false)
            }
            if (event.key === 'ArrowDown' && models.length) {
              event.preventDefault()
              openList()
              requestAnimationFrame(() => focusSelectableOption(0, 1))
            }
          }}
          role="combobox"
          aria-label="模型 ID"
          aria-autocomplete="none"
          aria-expanded={isOpen}
          aria-controls={listId}
          className="min-w-0 flex-1 bg-transparent px-2 py-1.5 outline-none"
          placeholder={options[0] ?? '输入模型 ID'}
        />
        <button
          type="button"
          aria-label="显示可用模型"
          aria-expanded={isOpen}
          aria-controls={listId}
          onClick={() => isOpen ? setIsOpen(false) : openList()}
          className="flex shrink-0 items-center px-2 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
        >
          <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {isOpen && (
        <div id={listId} role="listbox" aria-label="可用模型" className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-gray-200/60 bg-white/95 py-1 shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:border-white/[0.08] dark:bg-gray-900/95">
          {status === 'loading' && <p role="status" className="px-3 py-2 text-xs text-gray-500">加载中…</p>}
          {status === 'failed' && <p role="status" className="px-3 py-2 text-xs text-amber-700">获取上游模型失败，已显示预设模型列表。</p>}
          {status !== 'loading' && models.map((model, index) => {
            const availability = resolveModelAvailability(model, protocols)
            const mode = availability.kind === 'available' ? availability.protocol : null
            const selectable = mode !== null && allowedModes.includes(mode)
            return (
              <button
                key={model}
                ref={(element) => { optionRefs.current[index] = element }}
                type="button"
                role="option"
                aria-selected={model === value}
                disabled={!selectable}
                onClick={() => {
                  if (mode) onSelect(model, mode)
                  setIsOpen(false)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    inputRef.current?.focus()
                    setIsOpen(false)
                  }
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    focusSelectableOption(index + (event.key === 'ArrowDown' ? 1 : -1), event.key === 'ArrowDown' ? 1 : -1)
                  }
                }}
                className={`flex w-full justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/[0.06] ${model === value ? 'bg-blue-50 font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300'}`}
              >
                <span className="truncate">{model}</span><span className="shrink-0">{availability.kind === 'no-image-generation' ? '无图像生成能力' : mode ?? '协议未知，无法选择'}{mode && !selectable ? '（未启用）' : ''}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

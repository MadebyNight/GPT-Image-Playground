import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDownIcon } from './icons'

interface ModelComboboxProps {
  value: string
  options: string[]
  onChange: (model: string) => void
}

export default function ModelCombobox({ value, options, onChange }: ModelComboboxProps) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const listId = useId()

  useEffect(() => {
    if (!isOpen) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick)
  }, [isOpen])

  return (
    <div ref={containerRef} className="relative">
      <div className="flex w-full rounded-lg border border-blue-100 bg-white/80 text-xs text-gray-700 transition focus-within:border-blue-300 focus-within:ring-2 focus-within:ring-blue-500/20 dark:border-blue-500/20 dark:bg-white/[0.04] dark:text-gray-100">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setIsOpen(true)}
          onClick={() => setIsOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && isOpen) {
              event.stopPropagation()
              setIsOpen(false)
            }
            if (event.key === 'ArrowDown' && options.length) {
              event.preventDefault()
              setIsOpen(true)
              requestAnimationFrame(() => optionRefs.current[0]?.focus())
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
          aria-label="显示预设模型"
          aria-expanded={isOpen}
          aria-controls={listId}
          onClick={() => setIsOpen((open) => !open)}
          className="flex shrink-0 items-center px-2 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
        >
          <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {isOpen && (
        <div id={listId} role="listbox" aria-label="预设模型" className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-gray-200/60 bg-white/95 py-1 shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:border-white/[0.08] dark:bg-gray-900/95">
          {options.map((model, index) => (
            <button
              key={model}
              ref={(element) => { optionRefs.current[index] = element }}
              type="button"
              role="option"
              aria-selected={model === value}
              onClick={() => {
                onChange(model)
                inputRef.current?.focus()
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
                  optionRefs.current[(index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length]?.focus()
                }
              }}
              className={`block w-full px-3 py-2 text-left text-xs hover:bg-gray-50 dark:hover:bg-white/[0.06] ${model === value ? 'bg-blue-50 font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300'}`}
            >
              {model}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

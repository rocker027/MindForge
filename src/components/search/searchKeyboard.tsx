import { useRef, useEffect, useCallback, useLayoutEffect } from 'react'

type SearchKeyboardAction = 'close' | 'next' | 'previous' | 'select'
// WKWebView can emit duplicate non-text navigation keydowns around native key injection.
const NATIVE_KEYDOWN_DUPLICATE_WINDOW_MS = 500
const handledSearchKeyboardEvents = new WeakSet<Event>()

export interface SearchKeyboardEvent {
  key: string
  nativeEvent?: Event
  preventDefault: () => void
  repeat?: boolean
  stopImmediatePropagation?: () => void
  stopPropagation?: () => void
  timeStamp?: number
}

interface SearchKeydownRecord {
  key: string
  timeStamp: number
}

interface SearchKeyboardActionContext<T> {
  handleSelect: (item: T) => void
  onClose: () => void
  resultsRef: React.MutableRefObject<T[]>
  selectedIndexRef: React.MutableRefObject<number>
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
}

function resolveSearchKeyboardAction(key: string): SearchKeyboardAction | null {
  switch (key) {
    case 'Escape':
      return 'close'
    case 'ArrowDown':
      return 'next'
    case 'ArrowUp':
      return 'previous'
    case 'Enter':
      return 'select'
    default:
      return null
  }
}

function nextSearchSelectionIndex(
  action: Extract<SearchKeyboardAction, 'next' | 'previous'>,
  currentIndex: number,
  resultCount: number,
): number {
  if (resultCount <= 0) return 0
  if (action === 'next') return Math.min(currentIndex + 1, resultCount - 1)
  return Math.max(currentIndex - 1, 0)
}

function shouldHandleKeydown(
  event: SearchKeyboardEvent,
  pressedKeys: Set<string>,
  handledEvents: WeakSet<Event>,
  recentKeydownRef: React.MutableRefObject<SearchKeydownRecord | null>,
): boolean {
  const eventIdentity = resolveSearchKeyboardEventIdentity(event)
  if (eventIdentity) {
    if (handledEvents.has(eventIdentity)) return false
    handledEvents.add(eventIdentity)
  }

  if (isDuplicateNativeKeydown(event, recentKeydownRef.current)) {
    return false
  }

  rememberSearchKeydown(event, recentKeydownRef)
  if (event.repeat) return true
  if (pressedKeys.has(event.key)) return false

  pressedKeys.add(event.key)
  return true
}

function isDuplicateNativeKeydown(
  event: SearchKeyboardEvent,
  previous: SearchKeydownRecord | null,
): boolean {
  const timeStamp = resolveSearchKeyboardEventTimestamp(event)
  if (!previous || timeStamp === null || previous.key !== event.key) return false

  const elapsedMs = timeStamp - previous.timeStamp
  return elapsedMs >= 0 && elapsedMs <= NATIVE_KEYDOWN_DUPLICATE_WINDOW_MS
}

function rememberSearchKeydown(
  event: SearchKeyboardEvent,
  recentKeydownRef: React.MutableRefObject<SearchKeydownRecord | null>,
) {
  const timeStamp = resolveSearchKeyboardEventTimestamp(event)
  if (timeStamp !== null) recentKeydownRef.current = { key: event.key, timeStamp }
}

function resolveSearchKeyboardEventTimestamp(event: SearchKeyboardEvent): number | null {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now()

  const { timeStamp } = event
  return typeof timeStamp === 'number' && Number.isFinite(timeStamp) ? timeStamp : null
}

function resolveSearchKeyboardEventIdentity(event: SearchKeyboardEvent): Event | null {
  if (event.nativeEvent instanceof Event) return event.nativeEvent
  if (event instanceof Event) return event
  return null
}

function applySearchSelection<T>(
  action: Extract<SearchKeyboardAction, 'next' | 'previous'>,
  resultsRef: React.MutableRefObject<T[]>,
  selectedIndexRef: React.MutableRefObject<number>,
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>,
) {
  const nextIndex = nextSearchSelectionIndex(action, selectedIndexRef.current, resultsRef.current.length)
  selectedIndexRef.current = nextIndex
  setSelectedIndex(nextIndex)
}

function performSearchKeyboardAction<T>(action: SearchKeyboardAction, context: SearchKeyboardActionContext<T>) {
  if (action === 'close') {
    context.onClose()
    return
  }

  if (action === 'select') {
    const result = context.resultsRef.current[context.selectedIndexRef.current]
    if (result) context.handleSelect(result)
    return
  }

  applySearchSelection(action, context.resultsRef, context.selectedIndexRef, context.setSelectedIndex)
}

function useSearchKeyboardDocumentListeners({
  handleKeyDown,
  handleKeyUp,
  open,
  pressedKeysRef,
}: {
  handleKeyDown: (event: KeyboardEvent) => void
  handleKeyUp: (event: KeyboardEvent) => void
  open: boolean
  pressedKeysRef: React.MutableRefObject<Set<string>>
}) {
  useEffect(() => {
    const pressedKeys = pressedKeysRef.current
    if (!open) {
      pressedKeys.clear()
      return
    }

    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('keyup', handleKeyUp, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('keyup', handleKeyUp, true)
      pressedKeys.clear()
    }
  }, [handleKeyDown, handleKeyUp, open, pressedKeysRef])
}

/** Mirrors `results`/`selectedIndex` into refs so document key handlers read fresh values. */
export function useSearchSelectionRefs<T>(results: T[], selectedIndex: number) {
  const resultsRef = useRef(results)
  const selectedIndexRef = useRef(selectedIndex)

  useLayoutEffect(() => {
    resultsRef.current = results
    selectedIndexRef.current = selectedIndex
  }, [results, selectedIndex])

  return { resultsRef, selectedIndexRef }
}

/**
 * Arrow/Enter/Escape navigation over a list of selectable items, hardened
 * against WKWebView's duplicate native keydown events. Generic over the item
 * type so keyword results and memory hits share one implementation.
 */
export function useSearchKeyboard<T>({
  open,
  onClose,
  handleSelect,
  resultsRef,
  selectedIndexRef,
  setSelectedIndex,
}: {
  open: boolean
  onClose: () => void
  handleSelect: (item: T) => void
  resultsRef: React.MutableRefObject<T[]>
  selectedIndexRef: React.MutableRefObject<number>
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
}) {
  const pressedKeysRef = useRef(new Set<string>())
  const recentKeydownRef = useRef<SearchKeydownRecord | null>(null)
  const handleKeyDown = useCallback((e: SearchKeyboardEvent) => {
    const action = resolveSearchKeyboardAction(e.key)
    if (!action) return

    e.preventDefault()
    e.stopImmediatePropagation?.()
    e.stopPropagation?.()
    if (!shouldHandleKeydown(e, pressedKeysRef.current, handledSearchKeyboardEvents, recentKeydownRef)) return

    performSearchKeyboardAction(action, { handleSelect, onClose, resultsRef, selectedIndexRef, setSelectedIndex })
  }, [handleSelect, onClose, resultsRef, selectedIndexRef, setSelectedIndex])

  const handleKeyUp = useCallback((e: { key: string }) => {
    if (resolveSearchKeyboardAction(e.key)) pressedKeysRef.current.delete(e.key)
  }, [])

  useSearchKeyboardDocumentListeners({ handleKeyDown, handleKeyUp, open, pressedKeysRef })
}

import { useState, useCallback, useEffect, useRef } from 'react'

/**
 * A tab is one file of one checkout. `path` is its key (unique across checkouts, and what the rest of the Editor compares
 * and passes around); `file` is the project-relative path the API takes; `checkout` is the task id of a worktree, or
 * undefined for the project folder. Main-checkout keys are the plain path, so tabs saved before worktrees still match.
 */
export interface EditorTab {
  path: string
  file: string
  /** Task whose worktree this copy of the file belongs to; undefined = the project folder (main checkout). */
  checkout?: string
  name: string
  extension: string
  originalContent: string
  content: string
  isDirty: boolean
  needsFetch: boolean
  diffMode?: 'staged' | 'unstaged'
  subrepo?: string
  /** Where to put the cursor once the editor shows the file (a search hit).
   *  `nonce` makes the same spot count again on a second open. */
  reveal?: EditorReveal
}

export interface EditorReveal {
  line: number
  /** 0-based character index in the line. */
  column?: number
  /** Characters to select from `column`. */
  length?: number
  nonce: number
}

export const tabKey = (file: string, checkout?: string) => (checkout ? `@task:${checkout}:${file}` : file)

export interface OpenFileOptions {
  /** Checkout the file is opened from (task id of a worktree). Default: the project folder. */
  checkout?: string
  diffMode?: 'staged' | 'unstaged'
  subrepo?: string
  reveal?: Omit<EditorReveal, 'nonce'>
}

interface PersistedTab {
  path: string
  file?: string
  checkout?: string
  name: string
  extension: string
}

const STORAGE_KEY = (projectId: string) => `shipyard:editor-tabs:${projectId}`
const ACTIVE_KEY = (projectId: string) => `shipyard:editor-active-tab:${projectId}`

function loadPersistedTabs(projectId: string): EditorTab[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(projectId))
    const list: PersistedTab[] = raw ? JSON.parse(raw) : []
    return list.map(p => {
      const file = p.file ?? p.path
      return { path: tabKey(file, p.checkout), file, checkout: p.checkout, name: p.name, extension: p.extension,
        originalContent: '', content: '', isDirty: false, needsFetch: true }
    })
  } catch { return [] }
}

function persistTabs(projectId: string, tabs: EditorTab[]) {
  const data: PersistedTab[] = tabs.map(t => ({ path: t.path, file: t.file, checkout: t.checkout, name: t.name, extension: t.extension }))
  localStorage.setItem(STORAGE_KEY(projectId), JSON.stringify(data))
}

function loadActiveTab(projectId: string): string | null {
  return localStorage.getItem(ACTIVE_KEY(projectId))
}

function persistActiveTab(projectId: string, path: string | null) {
  if (path) {
    localStorage.setItem(ACTIVE_KEY(projectId), path)
  } else {
    localStorage.removeItem(ACTIVE_KEY(projectId))
  }
}

export function useEditorTabs(projectId: string) {
  const [tabs, setTabs] = useState<EditorTab[]>(() => loadPersistedTabs(projectId))

  const [activeTabPath, setActiveTabPath] = useState<string | null>(() => {
    const saved = loadActiveTab(projectId)
    const persisted = loadPersistedTabs(projectId)
    if (saved && persisted.some(t => t.path === saved)) return saved
    return persisted.length > 0 ? persisted[0].path : null
  })

  // Reset when project changes
  const prevProjectId = useRef(projectId)
  useEffect(() => {
    if (prevProjectId.current !== projectId) {
      prevProjectId.current = projectId
      const persisted = loadPersistedTabs(projectId)
      setTabs(persisted)
      const saved = loadActiveTab(projectId)
      setActiveTabPath(saved && persisted.some(t => t.path === saved) ? saved : persisted[0]?.path || null)
    }
  }, [projectId])

  // Persist tabs on change
  useEffect(() => {
    persistTabs(projectId, tabs)
  }, [projectId, tabs])

  useEffect(() => {
    persistActiveTab(projectId, activeTabPath)
  }, [projectId, activeTabPath])

  const openFile = useCallback((file: string, name: string, extension: string, content: string, options?: OpenFileOptions) => {
    const reveal = options?.reveal ? { ...options.reveal, nonce: Date.now() } : undefined
    const path = tabKey(file, options?.checkout)
    setTabs(prev => {
      const existing = prev.find(t => t.path === path)
      if (existing) {
        // Update diff mode if changed
        if (options?.diffMode !== existing.diffMode) {
          return prev.map(t => t.path === path ? { ...t, diffMode: options?.diffMode, subrepo: options?.subrepo, reveal } : t)
        }
        return reveal ? prev.map(t => t.path === path ? { ...t, reveal } : t) : prev
      }
      return [...prev, {
        path,
        file,
        checkout: options?.checkout,
        name,
        extension,
        originalContent: content,
        content,
        isDirty: false,
        needsFetch: content === '',
        diffMode: options?.diffMode,
        subrepo: options?.subrepo,
        reveal,
      }]
    })
    setActiveTabPath(path)
  }, [])

  const initContent = useCallback((path: string, content: string) => {
    setTabs(prev => prev.map(t =>
      t.path === path && t.needsFetch
        ? { ...t, originalContent: content, content, needsFetch: false }
        : t
    ))
  }, [])

  const closeTab = useCallback((path: string) => {
    setTabs(prev => {
      const idx = prev.findIndex(t => t.path === path)
      if (idx === -1) return prev
      const next = prev.filter(t => t.path !== path)
      return next
    })
    setActiveTabPath(prev => {
      if (prev !== path) return prev
      const remaining = tabs.filter(t => t.path !== path)
      if (remaining.length === 0) return null
      const idx = tabs.findIndex(t => t.path === path)
      return remaining[Math.min(idx, remaining.length - 1)]?.path || null
    })
  }, [tabs])

  const setContent = useCallback((path: string, content: string) => {
    setTabs(prev => prev.map(t =>
      t.path === path
        ? { ...t, content, isDirty: content !== t.originalContent }
        : t
    ))
  }, [])

  const markSaved = useCallback((path: string, content: string) => {
    setTabs(prev => prev.map(t =>
      t.path === path
        ? { ...t, originalContent: content, content, isDirty: false }
        : t
    ))
  }, [])

  const setActiveTab = useCallback((path: string) => {
    setActiveTabPath(path)
  }, [])

  const hasDirtyTabs = tabs.some(t => t.isDirty)

  return {
    tabs,
    activeTabPath,
    openFile,
    initContent,
    closeTab,
    setContent,
    markSaved,
    setActiveTab,
    hasDirtyTabs,
  }
}

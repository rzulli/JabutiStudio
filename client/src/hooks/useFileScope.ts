import { createContext, useCallback, useContext, useEffect, useState } from 'react'

/**
 * Which checkout the file tree and file mutations work in: undefined = the project folder (main checkout), a task id =
 * that task's worktree. The Editor sets it through FileScopeContext; components outside the Editor get the main checkout.
 */
export const FileScopeContext = createContext<string | undefined>(undefined)
export const useFileScope = () => useContext(FileScopeContext)

const KEY = (projectId: string) => `shipyard:editor-checkout:${projectId}`
const EVENT = 'shipyard:editor-checkout'

export function readEditorCheckout(projectId: string): string | undefined {
  try { return localStorage.getItem(KEY(projectId)) || undefined } catch { return undefined }
}

/** The Editor's active checkout for a project, shared by every component that shows or acts on it. */
export function useEditorCheckout(projectId: string): [string | undefined, (taskId?: string) => void] {
  const [value, setValue] = useState(() => readEditorCheckout(projectId))
  useEffect(() => {
    setValue(readEditorCheckout(projectId))
    const onChange = (e: Event) => {
      const d = (e as CustomEvent<{ projectId: string; taskId?: string }>).detail
      if (d?.projectId === projectId) setValue(d.taskId)
    }
    window.addEventListener(EVENT, onChange)
    return () => window.removeEventListener(EVENT, onChange)
  }, [projectId])
  const set = useCallback((taskId?: string) => {
    try { if (taskId) localStorage.setItem(KEY(projectId), taskId); else localStorage.removeItem(KEY(projectId)) } catch { /* optional */ }
    setValue(taskId)
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { projectId, taskId } }))
  }, [projectId])
  return [value, set]
}

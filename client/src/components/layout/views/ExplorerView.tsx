import { useCallback } from 'react'
import { Files, FolderGit2 } from 'lucide-react'
import { useTabs } from '@/hooks/useTabs'
import { useProjects } from '@/hooks/useProjects'
import { useTasks, type Task } from '@/hooks/useTasks'
import { FileExplorer } from '@/components/files/FileExplorer'
import { FileScopeContext, useEditorCheckout } from '@/hooks/useFileScope'
import { useEditorTabsContext } from '@/hooks/useEditorTabsContext'

export function ExplorerView() {
  const { activeTabId } = useTabs()
  const { data: projects } = useProjects()
  const project = projects?.find(p => p.id === activeTabId)
  const editor = useEditorTabsContext()
  const { data: tasks } = useTasks(project?.id)
  // The checkout the tree shows and new opens come from. Tabs already open keep their own checkout.
  const [taskId, setTaskId] = useEditorCheckout(project?.id ?? '')
  const worktreeTasks = (tasks ?? []).filter((t: Task) => !!t.worktreePath)

  const handleOpenInEditor = useCallback((path: string, name: string, extension: string) => {
    if (!activeTabId) return
    editor.openFileForProject(activeTabId, path, name, extension, { checkout: taskId })
  }, [activeTabId, editor, taskId])

  if (!project) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 text-center">
        <Files className="h-8 w-8 text-muted-foreground/30 mb-2" />
        <p className="text-xs text-muted-foreground">
          Open a project to browse its files.
        </p>
      </div>
    )
  }

  const selected = taskId ? worktreeTasks.find((t: Task) => t.id === taskId) : undefined
  return (
    <div className="h-full flex flex-col px-2 py-2 min-h-0">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <FolderGit2 className="h-3 w-3 shrink-0" />
        <select
          value={taskId ?? ''}
          onChange={e => setTaskId(e.target.value || undefined)}
          className="h-6 min-w-0 flex-1 rounded border bg-background px-1 text-[11px] text-foreground"
          title="Which checkout the tree shows and new files open from"
          data-testid="explorer-checkout"
        >
          <option value="">Main checkout (project folder)</option>
          {worktreeTasks.map((t: Task) => <option key={t.id} value={t.id}>Task #{t.number ?? '?'} worktree — {t.title.slice(0, 28)}</option>)}
          {taskId && !selected && <option value={taskId}>Task worktree (no longer listed)</option>}
        </select>
      </div>
      <div className="min-h-0 flex-1">
        <FileScopeContext.Provider value={taskId}>
          <FileExplorer
            projectId={project.id}
            projectPath={project.path}
            onOpenInEditor={handleOpenInEditor}
            activeFilePath={editor.activeTabPath}
          />
        </FileScopeContext.Provider>
      </div>
    </div>
  )
}

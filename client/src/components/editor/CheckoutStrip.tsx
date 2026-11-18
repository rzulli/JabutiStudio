import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, FolderGit2, GitBranch } from 'lucide-react'
import { api } from '@/lib/api'
import { shortSha } from '@/lib/godotApi'

/**
 * Says which project and which checkout the active file belongs to, and where it stands (branch, commit, uncommitted).
 * A worktree that no longer resolves is shown as unavailable: the file requests for it are refused too.
 */
export function CheckoutStrip({ projectId, taskId }: { projectId: string; taskId?: string }) {
  const { data, error } = useQuery({
    queryKey: ['files', 'checkout', projectId, taskId ?? ''],
    queryFn: () => api.getFileCheckout(projectId, taskId),
    staleTime: 3_000,
  })

  if (error) {
    return (
      <div className="flex items-center gap-2 border-b bg-destructive/10 px-2 py-1 text-xs text-destructive">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 break-words">Checkout unavailable: {(error as Error).message}. Nothing is read or written from another checkout.</span>
      </div>
    )
  }
  if (!data) return null
  const who = data.isMainCheckout ? 'Main checkout (project folder)' : `Task #${data.taskNumber ?? '?'} worktree${data.taskTitle ? ` — ${data.taskTitle}` : ''}`
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b bg-card/30 px-2 py-1 text-[11px] text-muted-foreground" data-testid="checkout-strip">
      <span className="text-foreground">{data.projectName}</span>
      <span className={data.isMainCheckout ? '' : 'font-medium text-primary'} title={data.reason}>{who}</span>
      <span className="inline-flex items-center gap-1 font-mono"><GitBranch className="h-3 w-3" />{data.branch ?? (data.detached ? 'detached' : 'no branch')} @ {shortSha(data.head)}</span>
      <span className="inline-flex min-w-0 items-center gap-1 font-mono" title={data.checkoutPath}><FolderGit2 className="h-3 w-3 shrink-0" /><span className="truncate">{data.checkoutPath}</span></span>
      {data.dirty && data.dirty.count > 0 && <span className="text-warning">{data.dirty.count} uncommitted</span>}
    </div>
  )
}

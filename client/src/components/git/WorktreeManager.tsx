import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Loader2, AlertTriangle, Link2, Unlink, ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { useWorktreeInventory, useWorktreeChanges, useWorktreeLinkActions } from '@/hooks/useGit'
import { useTasks, type Task } from '@/hooks/useTasks'
import { api, type WorktreeInventoryEntry } from '@/lib/api'

const short = (h?: string | null) => (h || '').substring(0, 7)

function Changes({ projectId, path }: { projectId: string; path: string }) {
  const q = useWorktreeChanges(projectId, path, true)
  const [diff, setDiff] = useState<{ file: string; text: string } | null>(null)
  if (q.isLoading) return <Loader2 className="h-3.5 w-3.5 animate-spin" />
  const r = q.data?.report
  if (!r) return <p className="text-[11px] text-muted-foreground">Could not read the changes.</p>
  const res = r.resources
  const showDiff = async (file: string) => {
    try {
      const d = await api.getWorktreeDiff(projectId, path, file)
      setDiff({ file, text: (d.diff || '(no textual diff)') + (d.truncated ? '\n... truncated' : '') })
    } catch (e: any) {
      toast.error(e.message || 'No diff')
    }
  }
  return (
    <div className="space-y-1.5 text-[11px]">
      <p className="text-muted-foreground">
        {Object.entries(r.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(' · ') || 'no tracked changes'}
        {r.ignored.total > 0 ? ` · ${r.ignored.total} ignored` : ''}
      </p>
      {res.total > 0 && (
        <div className="rounded border px-2 py-1.5 space-y-1">
          <p className="font-medium">
            {res.total} .tres file{res.total === 1 ? '' : 's'}: {res.apparentReserialization} look re-serialized · {res.material} material · {res.unknown} unknown
            {res.withReferenceRemovals ? ` · ${res.withReferenceRemovals} lost ext_resource references` : ''}
          </p>
          {res.pattern && <p className="text-muted-foreground">Pattern: {res.pattern}. Evidence of a generator, not permission to discard.</p>}
          <div className="max-h-40 overflow-y-auto scrollbar-dark space-y-0.5">
            {res.files.map(f => (
              <button key={f.path} onClick={() => showDiff(f.path)} className="flex w-full items-center gap-2 text-left hover:bg-accent/50 rounded px-1">
                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${f.assessment === 'material' ? 'bg-warning' : 'bg-muted-foreground/50'}`} />
                <span className="font-mono truncate flex-1">{f.path}</span>
                <span className="text-muted-foreground shrink-0">{f.classification}{f.extResourcesRemoved.length ? ` (-${f.extResourcesRemoved.length} refs)` : ''}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {r.entries.filter(e => !e.path.endsWith('.tres')).slice(0, 30).map(e => (
        <div key={e.path} className="flex gap-2">
          <span className="text-muted-foreground w-24 shrink-0 truncate">{e.kinds.join('+')}</span>
          <span className="font-mono truncate">{e.path}</span>
        </div>
      ))}
      {diff && <pre className="max-h-60 overflow-auto scrollbar-dark rounded bg-muted p-2 text-[10px] font-mono whitespace-pre">{diff.file}{'\n'}{diff.text}</pre>}
    </div>
  )
}

function LinkPicker({ projectId, entry, onDone }: { projectId: string; entry: WorktreeInventoryEntry; onDone: () => void }) {
  const { data: tasks } = useTasks(projectId)
  const { link } = useWorktreeLinkActions(projectId)
  const [taskId, setTaskId] = useState('')
  const candidates = (tasks || []).filter((t: Task) => !t.worktreeBranch)
  const confirm = async () => {
    try {
      await link.mutateAsync({ taskId, path: entry.path })
      toast.success('Worktree linked to the task (nothing in it was changed)')
      onDone()
    } catch (e: any) {
      toast.error(e.message || 'Could not link')
    }
  }
  return (
    <div className="flex items-center gap-2 flex-wrap rounded bg-accent/40 px-2 py-1.5">
      <select className="text-[11px] bg-background border rounded px-1 py-1 max-w-[260px]" value={taskId} onChange={e => setTaskId(e.target.value)}>
        <option value="">Choose a task...</option>
        {candidates.map((t: Task) => <option key={t.id} value={t.id}>{t.number ? `#${t.number} ` : ''}{t.title}</option>)}
      </select>
      {taskId && (
        <span className="text-[10px] text-muted-foreground">
          Links <span className="font-mono">{entry.branch}</span> @ <span className="font-mono">{short(entry.head)}</span>. No files, commits or acceptance change.
        </span>
      )}
      <Button size="sm" className="text-xs h-7" disabled={!taskId || link.isPending} onClick={confirm}>Link</Button>
      <Button size="sm" variant="ghost" className="text-xs h-7" onClick={onDone}>Cancel</Button>
    </div>
  )
}

function Row({ projectId, w }: { projectId: string; w: WorktreeInventoryEntry }) {
  const [open, setOpen] = useState(false)
  const [linking, setLinking] = useState(false)
  const { unlink } = useWorktreeLinkActions(projectId)
  const f = w.flags
  const taskText = w.task
    ? ` · task ${w.task.number ? '#' + w.task.number : ''} ${w.task.title} (${w.task.stage}${w.task.origin === 'manual' ? ', linked by hand' : ''})`
    : w.isMain ? '' : ' · no task'
  return (
    <div className="px-3 py-2 space-y-1.5">
      <button className="flex w-full items-start gap-2 text-left" onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown className="h-3.5 w-3.5 mt-0.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 mt-0.5 shrink-0" />}
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] truncate" title={w.path}>{w.path}</p>
          <p className="text-[10px] text-muted-foreground">
            {w.isMain ? 'main checkout · ' : ''}{w.branch ?? (w.detached ? 'detached HEAD' : 'no branch')} · {short(w.head)}{taskText}
          </p>
        </div>
        <div className="flex gap-1 flex-wrap justify-end shrink-0">
          {f.taskLinked && <Badge variant="outline" className="text-[9px] px-1 py-0">task</Badge>}
          {f.unlinked && !w.isMain && <Badge variant="secondary" className="text-[9px] px-1 py-0">unlinked</Badge>}
          {f.integrated && <Badge variant="outline" className="text-[9px] px-1 py-0">integrated</Badge>}
          {f.unmerged && <Badge variant="secondary" className="text-[9px] px-1 py-0 text-warning">unmerged{w.unmergedCommits != null ? ` ${w.unmergedCommits}` : ''}</Badge>}
          {f.dirty && <Badge variant="secondary" className="text-[9px] px-1 py-0 text-warning">dirty{w.changes ? ` ${w.changes.total}` : ''}</Badge>}
          {f.busy && <Badge variant="secondary" className="text-[9px] px-1 py-0 text-warning">busy</Badge>}
          {f.unknown && <Badge variant="outline" className="text-[9px] px-1 py-0">unknown</Badge>}
        </div>
      </button>
      {open && (
        <div className="pl-5 space-y-2">
          {w.collisions.length > 0 && (
            <p className="text-[11px] text-warning flex gap-1"><AlertTriangle className="h-3 w-3 mt-0.5" />Also claimed by: {w.collisions.map(c => `#${c.number ?? c.id}`).join(', ')}</p>
          )}
          {w.unmergedCommits != null && (
            <p className="text-[11px] text-muted-foreground">
              {w.unmergedCommits} commit(s) not in {w.comparedTo.branch ?? '?'} ({w.comparedTo.reason === 'accepted-target' ? "the task's accepted target" : 'the branch checked out in the main checkout'})
            </p>
          )}
          {!w.isMain && (
            w.cleanup.allowed
              ? <p className="text-[11px] text-success">Can be closed from the task's Review tab.</p>
              : (
                <ul className="space-y-0.5">
                  {w.cleanup.blockers.map(b => (
                    <li key={b.code} className="text-[11px] text-muted-foreground flex gap-1"><AlertTriangle className="h-3 w-3 text-warning shrink-0 mt-0.5" />{b.message}</li>
                  ))}
                </ul>
              )
          )}
          {w.exists && w.flags.dirty && <Changes projectId={projectId} path={w.path} />}
          {!w.isMain && f.unlinked && !linking && w.exists && w.branch && (
            <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={() => setLinking(true)}><Link2 className="h-3 w-3" />Link to task...</Button>
          )}
          {linking && <LinkPicker projectId={projectId} entry={w} onDone={() => setLinking(false)} />}
          {w.task?.origin === 'manual' && (
            <Button
              size="sm" variant="ghost" className="h-7 gap-1.5 text-xs"
              onClick={async () => {
                try { await unlink.mutateAsync(w.task!.id); toast.success('Link removed; the worktree was not touched') }
                catch (e: any) { toast.error(e.message) }
              }}
            >
              <Unlink className="h-3 w-3" />Remove link (keeps the worktree)
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** The project's worktrees as Git registers them, next to their tasks. Read-only except linking; removal lives in the task's Review tab. */
export function WorktreeManager({ projectId, open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data, isLoading } = useWorktreeInventory(projectId, open)
  const s = data?.summary
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-sm">Worktrees</DialogTitle>
          <DialogDescription className="text-xs">
            {s ? `${s.total} registered · ${s.taskLinked} with a task · ${s.unlinked} without · ${s.dirty} dirty · ${s.unmerged} unmerged · ${s.busy} busy · ${s.closable} closable` : 'Read from git worktree list.'}
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-y-auto scrollbar-dark divide-y border rounded-md">
          {isLoading && <div className="p-4 flex justify-center"><Loader2 className="h-4 w-4 animate-spin" /></div>}
          {data?.worktrees.map(w => <Row key={w.path} projectId={projectId} w={w} />)}
        </div>
      </DialogContent>
    </Dialog>
  )
}

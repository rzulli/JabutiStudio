import { useState } from 'react'
import { Network, Boxes } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ProjectExplorer } from './ProjectExplorer'
import { SystemsExplorer } from './SystemsExplorer'

/**
 * Two ways into the same project: Systems (what the game is made of) and Files & symbols (Graphify).
 * Both stay mounted so switching never loses a search, a selection or the editor beside.
 */
export function ExplorerHost({ projectId, compact }: { projectId: string; compact: boolean }) {
  const key = `shipyard:explorer-mode:${projectId}`
  const [mode, setMode] = useState<'systems' | 'files'>(() => { try { return localStorage.getItem(key) === 'files' ? 'files' : 'systems' } catch { return 'systems' } })
  const [focus, setFocus] = useState<{ file: string; nonce: number } | undefined>()
  const choose = (m: 'systems' | 'files') => { setMode(m); try { localStorage.setItem(key, m) } catch { /* ignore */ } }
  const tab = (m: 'systems' | 'files', label: string, Icon: typeof Network) => (
    <button onClick={() => choose(m)} data-testid={`explorer-mode-${m}`}
      className={cn('flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium', mode === m ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
      <Icon className="h-3 w-3" />{label}
    </button>
  )
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        {tab('systems', 'Systems', Boxes)}
        {tab('files', 'Files & symbols', Network)}
      </div>
      <div className={cn('min-h-0 flex-1', mode === 'systems' ? 'block' : 'hidden')}>
        <SystemsExplorer projectId={projectId} onOpenInGraph={file => { setFocus({ file, nonce: Date.now() }); choose('files') }} />
      </div>
      <div className={cn('min-h-0 flex-1', mode === 'files' ? 'block' : 'hidden')}>
        <ProjectExplorer projectId={projectId} compact={compact} focusFile={focus} />
      </div>
    </div>
  )
}

import { useState } from 'react'
import { Sparkles, ChevronDown } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { ASSISTS, type AskAgent, type SystemActions } from './parts'

const KEY = 'shipyard:systems-assist-agent'
const read = (): 'claude' | 'codex' => { try { return localStorage.getItem(KEY) === 'codex' ? 'codex' : 'claude' } catch { return 'claude' } }

/** Optional assistance. Claude/Codex receive a brief and answer through propose_system: the result lands here as a reviewable proposal. */
export function AskMenu({ actions, areaId, target, label = 'Ask agent', small }: { actions: SystemActions; areaId?: string; target?: string; label?: string; small?: boolean }) {
  const [agent, setAgentState] = useState<'claude' | 'codex'>(read)
  const setAgent = (a: 'claude' | 'codex') => { setAgentState(a); try { localStorage.setItem(KEY, a) } catch { /* ignore */ } }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button data-testid="ask-menu" className={cn('flex items-center gap-1 rounded-md border hover:bg-accent', small ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]')}>
          <Sparkles className="h-3 w-3" /> {label} <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="space-y-1.5 text-[10px] font-normal text-muted-foreground">
          <span className="flex items-center gap-1">Agent:
            {(['claude', 'codex'] as const).map(a => (
              <button key={a} onClick={e => { e.preventDefault(); setAgent(a) }} className={cn('rounded border px-1.5 py-0.5', agent === a && 'bg-accent text-foreground')}>{a === 'claude' ? 'Claude' : 'Codex'}</button>
            ))}
          </span>
          <span className="block">Answers come back here as proposals. An agent cannot confirm anything.</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ASSISTS.map(a => (
          <DropdownMenuItem key={a.id} onSelect={() => actions.onAsk((agent === 'codex' ? 'codex' : 'claude') as AskAgent, areaId, a.goal(target))} data-testid={`assist-${a.id}`} className="flex-col items-start gap-0">
            <span className="text-xs">{a.label}</span><span className="text-[10px] text-muted-foreground">{a.hint}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

import { useState } from 'react'
import { Sparkles, ChevronDown } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { AgentRunChoice } from '@/lib/api'
import { RunConfigFields, readRunChoice, saveRunChoice } from '@/components/tasks/RunConfigSelect'
import { ASSISTS, type AskAgent, type SystemActions } from './parts'

export const ASSIST_RUN_KEY = 'shipyard:systems-assist-run'
const KEY = ASSIST_RUN_KEY

/** Optional assistance. Claude/Codex receive a brief and answer through propose_system: the result lands here as a reviewable proposal. */
export function AskMenu({ actions, areaId, target, label = 'Ask agent', small }: { actions: SystemActions; areaId?: string; target?: string; label?: string; small?: boolean }) {
  const [run, setRunState] = useState<AgentRunChoice>(() => readRunChoice(KEY))
  const setRun = (v: AgentRunChoice) => { setRunState(v); saveRunChoice(KEY, v) }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button data-testid="ask-menu" className={cn('flex items-center gap-1 rounded-md border hover:bg-accent', small ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]')}>
          <Sparkles className="h-3 w-3" /> {label} <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="space-y-1.5 text-[10px] font-normal text-muted-foreground">
          <RunConfigFields value={run} onChange={setRun} />
          <span className="block">Answers come back here as proposals. An agent cannot confirm anything.</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ASSISTS.map(a => (
          <DropdownMenuItem key={a.id} onSelect={() => actions.onAsk((run.agent === 'codex' ? 'codex' : 'claude') as AskAgent, areaId, a.goal(target), run)} data-testid={`assist-${a.id}`} className="flex-col items-start gap-0">
            <span className="text-xs">{a.label}</span><span className="text-[10px] text-muted-foreground">{a.hint}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

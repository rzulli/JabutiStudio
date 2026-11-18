import { useId } from 'react'
import { Bot, ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAgents, DEFAULT_AGENT_ID } from '@/hooks/useAgents'
import type { AgentRunChoice } from '@/lib/api'
import { cn } from '@/lib/utils'

const fieldCls = 'h-7 w-full rounded-md border bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring'

/** Remembers the last choice of a surface, so the next run starts where this one left off. */
export function readRunChoice(key: string): AgentRunChoice {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const v = JSON.parse(raw)
    return {
      agent: typeof v.agent === 'string' ? v.agent : undefined,
      model: typeof v.model === 'string' ? v.model : undefined,
      effort: typeof v.effort === 'string' ? v.effort : undefined,
    }
  } catch { return {} }
}

export function saveRunChoice(key: string, value: AgentRunChoice) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* ignore */ }
}

/** Harness, model and effort as three plain fields. Native controls on purpose: they work inside dialogs, popovers and menus alike. */
export function RunConfigFields({ value, onChange, className }: {
  value: AgentRunChoice
  onChange: (next: AgentRunChoice) => void
  className?: string
}) {
  const { data } = useAgents()
  const uid = useId()
  const agents = data?.agents || []
  const agentId = value.agent || data?.defaultAgent || DEFAULT_AGENT_ID
  const current = agents.find(a => a.id === agentId)
  const models = current?.models || []
  const efforts = current?.efforts || []
  const takesModel = !!current && hasModelFlag(current.id, models.length)

  const setAgent = (id: string) => {
    const next = agents.find(a => a.id === id)
    onChange({
      agent: id,
      // A model id means nothing to another harness; an effort level may carry over when it is offered there too.
      model: undefined,
      effort: value.effort && next?.efforts?.includes(value.effort) ? value.effort : undefined,
    })
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div className="space-y-1">
        <label htmlFor={`${uid}-agent`} className="text-[11px] font-medium text-muted-foreground">Harness</label>
        <select id={`${uid}-agent`} className={fieldCls} value={agentId} onChange={e => setAgent(e.target.value)}>
          {agents.map(a => (
            <option key={a.id} value={a.id}>{a.name}{a.available === false ? ' (not installed)' : ''}</option>
          ))}
          {!current && <option value={agentId}>{agentId}</option>}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${uid}-model`} className="text-[11px] font-medium text-muted-foreground">Model</label>
        <input
          id={`${uid}-model`}
          className={fieldCls}
          list={`${uid}-models`}
          value={value.model || ''}
          disabled={!takesModel}
          placeholder={takesModel ? 'Default' : "This harness' own setting"}
          onChange={e => onChange({ ...value, agent: agentId, model: e.target.value.trim() || undefined })}
        />
        <datalist id={`${uid}-models`}>
          {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </datalist>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${uid}-effort`} className="text-[11px] font-medium text-muted-foreground">Effort</label>
        <select
          id={`${uid}-effort`}
          className={fieldCls}
          value={value.effort || ''}
          disabled={efforts.length === 0}
          onChange={e => onChange({ ...value, agent: agentId, effort: e.target.value || undefined })}
        >
          <option value="">{efforts.length === 0 ? 'Not available' : 'Default'}</option>
          {efforts.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
      </div>
    </div>
  )
}

// Harnesses that list suggestions certainly have a model flag; the others in the built-in set do too (see the
// server's AGENT_CAPABILITIES). A custom agent has none we know of, so its field stays off.
const BUILTIN_WITH_MODEL = new Set(['claude', 'codex', 'gemini', 'aider', 'opencode', 'cursor'])
function hasModelFlag(id: string, suggestions: number) {
  return suggestions > 0 || BUILTIN_WITH_MODEL.has(id)
}

/** One compact control — "Claude Code · Opus · high" — that opens harness, model and effort together. */
export function RunConfigSelect({ value, onChange, className, disabled }: {
  value: AgentRunChoice
  onChange: (next: AgentRunChoice) => void
  className?: string
  disabled?: boolean
}) {
  const { data } = useAgents()
  const agentId = value.agent || data?.defaultAgent || DEFAULT_AGENT_ID
  const name = data?.agents.find(a => a.id === agentId)?.name || agentId
  const summary = [name, value.model, value.effort].filter(Boolean).join(' · ')

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid="run-config"
          className={cn('inline-flex h-7 max-w-[260px] items-center gap-1.5 rounded-md border bg-background px-2 text-xs hover:bg-accent disabled:opacity-50', className)}
        >
          <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{summary}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <RunConfigFields value={value} onChange={onChange} />
      </PopoverContent>
    </Popover>
  )
}

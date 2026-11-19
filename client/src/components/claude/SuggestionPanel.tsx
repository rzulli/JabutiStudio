import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { appendedText, defaultPicks, type Change } from '@/lib/suggestions'

/**
 * Preview and selective apply for an agent suggestion. Shows, per field, what is there now and what applying would
 * change. Nothing is written until the person presses Apply; Discard leaves the form as it was.
 */
export function SuggestionPanel({ heading, changes, notes = [], onApply, onDiscard, testId = 'suggestion-panel' }: {
  heading: string
  changes: Change[]
  notes?: string[]
  onApply: (picks: Record<string, boolean>) => void
  onDiscard: () => void
  testId?: string
}) {
  const [picks, setPicks] = useState<Record<string, boolean>>(() => defaultPicks(changes))
  const applicable = changes.filter(c => c.kind !== 'info')
  const anyChosen = applicable.some(c => picks[c.key])

  if (!changes.length && !notes.length) {
    return (
      <div className="flex items-center gap-2 rounded-md border p-2 text-[11px] text-muted-foreground" role="status" data-testid={`${testId}-none`}>
        Nothing to change. <button type="button" className="underline" onClick={onDiscard}>Dismiss</button>
      </div>
    )
  }

  return (
    <div className="space-y-2 rounded-md border border-primary/40 bg-accent/30 p-3" data-testid={testId}>
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium">{heading}</p>
        <span className="text-[10px] text-muted-foreground">Nothing is applied until you tick it and press Apply.</span>
        <button type="button" onClick={onDiscard} className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" data-testid="suggestion-discard">
          <X className="h-3 w-3" /> Discard
        </button>
      </div>

      {changes.map(c => {
        const info = c.kind === 'info'
        const next = c.kind === 'append' ? appendedText(c.current, c.proposed) : c.proposed
        return (
          <label key={c.key} className={cn('block space-y-1 rounded border bg-background p-2 text-[11px]', !info && !picks[c.key] && 'opacity-80')}
            data-testid="suggestion-change" data-key={c.key} data-kind={c.kind}>
            <span className="flex items-center gap-1.5">
              {!info && <input type="checkbox" checked={!!picks[c.key]} onChange={e => setPicks(p => ({ ...p, [c.key]: e.target.checked }))} data-testid={`suggestion-pick-${c.key}`} />}
              <span className="font-medium">{c.label}</span>
              <span className="rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground">
                {c.kind === 'replace' ? 'replaces' : c.kind === 'append' ? 'adds below' : c.kind === 'subtasks' ? 'adds subtasks' : 'information only'}
              </span>
              {!info && !c.current.trim() && <span className="text-muted-foreground">(empty now)</span>}
            </span>
            {c.kind === 'replace' && c.current.trim() && <span className="block whitespace-pre-wrap text-muted-foreground line-through decoration-muted-foreground/50">{c.current.slice(0, 240)}</span>}
            {c.kind === 'append' && c.current.trim() && <span className="block whitespace-pre-wrap text-muted-foreground">{c.current.slice(0, 160)}{c.current.length > 160 ? '…' : ''}</span>}
            <span className={cn('block whitespace-pre-wrap', c.kind === 'append' && 'text-success')}>
              {c.kind === 'subtasks' ? c.proposed.split('\n').map(s => `• ${s}`).join('\n') : c.kind === 'append' ? `+ ${c.proposed}` : next.slice(0, 400)}
            </span>
          </label>
        )
      })}

      {notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground" data-testid="suggestion-notes">
          {notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}

      {applicable.length > 0 && (
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!anyChosen} onClick={() => onApply(picks)} data-testid="suggestion-apply">Apply selected</Button>
          <span className="text-[10px] text-muted-foreground">Fields you already filled are unticked by default.</span>
        </div>
      )}
    </div>
  )
}

import type { Task } from '@/hooks/useTasks'

export type HistoryKind = 'created' | 'inbox' | 'started' | 'done' | 'note' | 'follow-up' | 'attachment' | 'comment' | 'edited'
  | 'accepted' | 'acceptance-revoked' | 'integrated' | 'integration-refused'

export interface HistoryEntry {
  id: string
  kind: HistoryKind
  /** Epoch ms. */
  at: number
  /** Short line shown next to the kind. */
  title?: string
  /** Full text, when there is more than one line to read. */
  body?: string
}

/**
 * `— Note YYYY-MM-DD HH:MM` (UTC) is what log_task_progress, the "Needs
 * changes" route and a WhatsApp follow-up append to the prompt — the same
 * shape the activity feed reads (lib/activityFeed.ts).
 */
const NOTE_HEADER = /^— Note (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\s*$/
const SECTION_HEADER = /^— /
const FOLLOW_UP_PREFIX = /^Client follow-up \(WhatsApp\):\s*/

function time(iso: string | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

function noteEntries(prompt: string | undefined): HistoryEntry[] {
  if (!prompt || !prompt.includes('— Note')) return []
  const lines = prompt.split('\n')
  const out: HistoryEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = NOTE_HEADER.exec(lines[i].trim())
    if (!m) continue
    const at = Date.parse(`${m[1]}T${m[2]}:00Z`)
    if (Number.isNaN(at)) continue
    const body: string[] = []
    let j = i + 1
    for (; j < lines.length && !SECTION_HEADER.test(lines[j].trim()); j++) body.push(lines[j])
    const text = body.join('\n').trim()
    const first = text.split('\n')[0] || ''
    const followUp = FOLLOW_UP_PREFIX.test(first)
    out.push({
      id: `note-${at}-${out.length}`,
      kind: followUp ? 'follow-up' : 'note',
      at,
      title: (followUp ? first.replace(FOLLOW_UP_PREFIX, '') : first).replace(/^Complemento:\s*/i, ''),
      // Plain text: markdown heading marks only add noise to a timeline.
      body: text.split('\n').slice(1).join('\n').replace(/^#{1,6}\s+/gm, '').trim() || undefined,
    })
    i = j - 1
  }
  return out
}

/**
 * Everything that happened to a task, newest first, from what the record
 * already keeps: status timestamps, the dated notes in the prompt, inbox
 * attachments and board comments. A status moved twice keeps only its last
 * time — the task stores one timestamp per stage.
 */
/** One event of the server-kept lifecycle ledger (acceptance and integration). */
export interface LifecycleHistoryEvent { at: string; event: string; detail?: Record<string, unknown> }

const LIFECYCLE_KINDS = new Set<HistoryKind>(['accepted', 'acceptance-revoked', 'integrated', 'integration-refused'])

const sha = (v: unknown) => (typeof v === 'string' ? v.substring(0, 7) : undefined)

export function buildTaskHistory(task: Task, lifecycle: LifecycleHistoryEvent[] = []): HistoryEntry[] {
  const out: HistoryEntry[] = []
  const push = (kind: HistoryKind, iso: string | undefined, title?: string, body?: string) => {
    const at = time(iso)
    if (at != null) out.push({ id: `${kind}-${at}`, kind, at, title, body })
  }

  push('created', task.createdAt)
  const created = time(task.createdAt) ?? 0
  // Entering the inbox at creation is not news; coming back to it later is.
  if ((time(task.inboxAt) ?? 0) - created > 60_000) push('inbox', task.inboxAt)
  push('started', task.inProgressAt)
  push('done', task.doneAt, task.resolution?.split('\n')[0])
  out.push(...noteEntries(task.prompt))

  // Lifecycle events are real records of the ledger; unknown event names are skipped, never guessed.
  for (const ev of lifecycle) {
    if (!LIFECYCLE_KINDS.has(ev.event as HistoryKind)) continue
    const d = ev.detail || {}
    const target = typeof d.targetBranch === 'string' ? d.targetBranch : undefined
    const title =
      ev.event === 'accepted' ? [sha(d.headSha), target && `for ${target}`].filter(Boolean).join(' ') || undefined
      : ev.event === 'integrated' ? [sha(d.mergeCommit) && `merge ${sha(d.mergeCommit)}`, sha(d.headSha) && `of ${sha(d.headSha)}`].filter(Boolean).join(' ') || undefined
      : ev.event === 'integration-refused' ? (typeof d.message === 'string' ? d.message : undefined)
      : sha(d.headSha)
    push(ev.event as HistoryKind, ev.at, title)
  }

  for (const a of task.attachments || []) {
    if (a.source === 'inbox') push('attachment', a.date, a.name)
  }
  for (const c of task.comments || []) {
    push('comment', c.date, c.author, c.text)
  }

  // An edit after the last thing we can name still counts as a change.
  const latest = out.reduce((max, e) => Math.max(max, e.at), 0)
  const updated = time(task.updatedAt)
  if (updated != null && updated - latest > 2 * 60_000) push('edited', task.updatedAt)

  // Ids must be unique for React even when two events share a minute.
  const seen = new Map<string, number>()
  for (const e of out) {
    const n = seen.get(e.id) ?? 0
    seen.set(e.id, n + 1)
    if (n) e.id = `${e.id}-${n}`
  }
  // Events inside the same two seconds keep their causal order (created, started, done) instead of an arbitrary one.
  const RANK: Partial<Record<HistoryKind, number>> = { created: 0, inbox: 1, started: 2, done: 3, accepted: 4, integrated: 5 }
  return out.sort((a, b) => (Math.abs(a.at - b.at) < 2000 ? (RANK[b.kind] ?? 9) - (RANK[a.kind] ?? 9) : b.at - a.at))
}

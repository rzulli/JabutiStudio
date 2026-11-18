import { useQuery } from '@tanstack/react-query'
import { godotApi, type GodotSelection } from '@/lib/godotApi'

/**
 * Godot execution state. These are the pieces a future Testing tab reuses as they are: the resolved
 * Execution Context, the runs of a file, and one run's live view. Nothing here starts a run; the
 * components do that on an explicit click.
 */

export const godotKeys = {
  status: (projectId?: string) => ['godot', 'status', projectId] as const,
  context: (projectId: string | undefined, s: GodotSelection) => ['godot', 'context', projectId, s.taskId ?? '', s.checkout ?? '', s.file ?? '', s.origin ?? ''] as const,
  runs: (projectId?: string, file?: string, taskId?: string) => ['godot', 'runs', projectId, file ?? '', taskId ?? ''] as const,
  run: (projectId?: string, runId?: string) => ['godot', 'run', projectId, runId] as const,
}

export function useGodotStatus(projectId: string | undefined, enabled = true) {
  return useQuery({ queryKey: godotKeys.status(projectId), queryFn: () => godotApi.status(projectId!), enabled: !!projectId && enabled, staleTime: 30_000 })
}

export function useGodotContext(projectId: string | undefined, selection: GodotSelection, enabled = true) {
  return useQuery({ queryKey: godotKeys.context(projectId, selection), queryFn: () => godotApi.context(projectId!, selection), enabled: !!projectId && enabled, staleTime: 3_000 })
}

/** Runs of a file; polls while the dialog asks for it (a run is in flight). */
export function useGodotRuns(projectId: string | undefined, file: string | undefined, poll: boolean, enabled = true, taskId?: string) {
  return useQuery({ queryKey: godotKeys.runs(projectId, file, taskId), queryFn: () => godotApi.runs(projectId!, file, taskId), enabled: !!projectId && enabled, refetchInterval: poll ? 1500 : false, staleTime: 2_000 })
}

export function useGodotRun(projectId: string | undefined, runId: string | undefined) {
  return useQuery({
    queryKey: godotKeys.run(projectId, runId), queryFn: () => godotApi.runView(projectId!, runId!), enabled: !!projectId && !!runId,
    refetchInterval: q => (q.state.data?.running ? 1000 : false),
  })
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

export function useGitStatus(projectId: string | undefined, subrepo?: string) {
  return useQuery({
    queryKey: ['git-status', projectId, subrepo],
    queryFn: () => api.getGitStatus(projectId!, subrepo),
    enabled: !!projectId,
    refetchInterval: 5000,
  })
}

export function useGitDiff(projectId: string | undefined, file?: string, staged = false, subrepo?: string) {
  return useQuery({
    queryKey: ['git-diff', projectId, file, staged, subrepo],
    queryFn: () => api.getGitDiff(projectId!, file, staged, subrepo),
    enabled: !!projectId,
  })
}

export function useGitFileAtRef(projectId: string | undefined, file: string | undefined, ref = 'HEAD', subrepo?: string) {
  return useQuery({
    queryKey: ['git-show', projectId, file, ref, subrepo],
    queryFn: () => api.getGitFileAtRef(projectId!, file!, ref, subrepo),
    enabled: !!projectId && !!file,
  })
}

export function useGitLog(projectId: string | undefined, subrepo?: string) {
  return useQuery({
    queryKey: ['git-log', projectId, subrepo],
    queryFn: () => api.getGitLog(projectId!, subrepo),
    enabled: !!projectId,
    refetchInterval: 10_000,
  })
}

export function useGitBranches(projectId: string | undefined, subrepo?: string) {
  return useQuery({
    queryKey: ['git-branches', projectId, subrepo],
    queryFn: () => api.getGitBranches(projectId!, subrepo),
    enabled: !!projectId,
  })
}

export function useGitWorktrees(projectId: string | undefined, subrepo?: string) {
  return useQuery({
    queryKey: ['git-worktrees', projectId, subrepo],
    queryFn: () => api.getGitWorktrees(projectId!, subrepo),
    enabled: !!projectId,
    refetchInterval: 30_000,
  })
}

export function useCommitDiff(projectId: string | undefined, hash: string | undefined, subrepo?: string) {
  return useQuery({
    queryKey: ['commit-diff', projectId, hash, subrepo],
    queryFn: () => api.getCommitDiff(projectId!, hash!, subrepo),
    enabled: !!projectId && !!hash,
    staleTime: Infinity, // commit diffs don't change
  })
}

/**
 * Commits and working-tree state inside a task's window. `since` is the task's
 * inProgressAt; `until` bounds a finished task so later work does not leak in.
 */
export function useTaskGitReview(
  projectId: string | undefined,
  since: string | undefined,
  until?: string,
  subrepo?: string,
  enabled = true,
) {
  return useQuery({
    queryKey: ['task-git-review', projectId, since, until, subrepo],
    queryFn: () => api.getTaskGitReview(projectId!, since!, until, subrepo),
    enabled: enabled && !!projectId && !!since,
    refetchInterval: 15_000,
  })
}

export function useGitMainCommit(projectId: string | undefined, currentBranch?: string, subrepo?: string) {
  const isNotMain = !!currentBranch && currentBranch !== 'main' && currentBranch !== 'master'
  return useQuery({
    queryKey: ['git-main-commit', projectId, subrepo],
    queryFn: () => api.getGitMainCommit(projectId!, subrepo),
    enabled: !!projectId && isNotMain,
    staleTime: 60_000,
  })
}

export function useCheckoutBranch() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, branch, subrepo }: { projectId: string; branch: string; subrepo?: string }) =>
      api.checkoutBranch(projectId, branch, subrepo),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['git-status', variables.projectId, variables.subrepo] })
      queryClient.invalidateQueries({ queryKey: ['git-branches', variables.projectId, variables.subrepo] })
      queryClient.invalidateQueries({ queryKey: ['git-log', variables.projectId, variables.subrepo] })
      queryClient.invalidateQueries({ queryKey: ['git-main-commit', variables.projectId, variables.subrepo] })
    },
  })
}

export function useStageFile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, file, subrepo }: { projectId: string; file: string; subrepo?: string }) =>
      api.stageFile(projectId, file, subrepo),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['git-status', variables.projectId, variables.subrepo] })
    },
  })
}

export function useStageAll() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, subrepo }: { projectId: string; subrepo?: string }) => api.stageAll(projectId, subrepo),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['git-status', variables.projectId, variables.subrepo] })
    },
  })
}

export function useUnstageAll() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, subrepo }: { projectId: string; subrepo?: string }) => api.unstageAll(projectId, subrepo),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['git-status', variables.projectId, variables.subrepo] })
    },
  })
}

export function useUnstageFile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, file, subrepo }: { projectId: string; file: string; subrepo?: string }) =>
      api.unstageFile(projectId, file, subrepo),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['git-status', variables.projectId, variables.subrepo] })
    },
  })
}

export function useGitCommit() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, message, subrepo }: { projectId: string; message: string; subrepo?: string }) =>
      api.gitCommit(projectId, message, subrepo),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['git-status', variables.projectId, variables.subrepo] })
      queryClient.invalidateQueries({ queryKey: ['git-log', variables.projectId, variables.subrepo] })
    },
  })
}

export function useGitPush() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, subrepo }: { projectId: string; subrepo?: string }) => api.gitPush(projectId, subrepo),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['git-status', variables.projectId, variables.subrepo] })
      queryClient.invalidateQueries({ queryKey: ['git-log', variables.projectId, variables.subrepo] })
    },
  })
}

export function useGitPull() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, subrepo }: { projectId: string; subrepo?: string }) => api.gitPull(projectId, subrepo),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['git-status', variables.projectId, variables.subrepo] })
      queryClient.invalidateQueries({ queryKey: ['git-log', variables.projectId, variables.subrepo] })
    },
  })
}

export function useUndoCommit() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, subrepo }: { projectId: string; subrepo?: string }) => api.undoCommit(projectId, subrepo),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['git-status', variables.projectId, variables.subrepo] })
      queryClient.invalidateQueries({ queryKey: ['git-log', variables.projectId, variables.subrepo] })
    },
  })
}

export function useDiscardFile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, file, type, subrepo }: { projectId: string; file: string; type: 'staged' | 'unstaged' | 'untracked'; subrepo?: string }) =>
      api.discardFile(projectId, file, type, subrepo),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['git-status', variables.projectId, variables.subrepo] })
    },
  })
}

export function useGenerateCommitMessage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, subrepo }: { projectId: string; subrepo?: string }) => api.generateCommitMessage(projectId, subrepo),
    onSettled: (_, __, variables) => {
      queryClient.invalidateQueries({ queryKey: ['git-status', variables.projectId, variables.subrepo] })
    },
  })
}

export function useDiscardAll() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, section, subrepo }: { projectId: string; section: 'staged' | 'unstaged'; subrepo?: string }) =>
      api.discardAll(projectId, section, subrepo),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['git-status', variables.projectId, variables.subrepo] })
    },
  })
}

/** Derived lifecycle of one task: execution, delivery, acceptance, integration (see server taskLifecycle.ts). */
export function useTaskLifecycle(projectId: string | undefined, taskId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['task-lifecycle', projectId, taskId],
    queryFn: () => api.getTaskLifecycle(projectId!, taskId!),
    enabled: enabled && !!projectId && !!taskId,
    refetchInterval: 8_000,
  })
}

/**
 * Stage of every task with a worktree branch, in one request. A map by task id:
 * tasks without a branch are absent on purpose (nothing about them is verifiable).
 * Only runs while a board or rail is mounted.
 */
export function useLifecycleSummary(projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['task-lifecycle-summary', projectId],
    queryFn: () => api.getLifecycleSummary(projectId!),
    enabled: enabled && !!projectId,
    refetchInterval: 10_000,
    select: data => new Map(data.tasks.map(t => [t.taskId, t])),
  })
}

export function useTaskLifecycleActions(projectId: string, taskId: string) {
  const qc = useQueryClient()
  const done = () => {
    qc.invalidateQueries({ queryKey: ['task-lifecycle', projectId, taskId] })
    qc.invalidateQueries({ queryKey: ['task-lifecycle-summary', projectId] })
    qc.invalidateQueries({ queryKey: ['tasks', projectId] })
    qc.invalidateQueries({ queryKey: ['tasks', 'all'] })
    qc.invalidateQueries({ queryKey: ['git-status', projectId] })
    qc.invalidateQueries({ queryKey: ['git-pending', projectId] })
  }
  return {
    accept: useMutation({ mutationFn: (b: { targetBranch: string; expectedHeadSha: string; note?: string }) => api.acceptTaskDelivery(projectId, taskId, b), onSettled: done }),
    revoke: useMutation({ mutationFn: () => api.revokeTaskAcceptance(projectId, taskId), onSettled: done }),
    integrate: useMutation({ mutationFn: (b: { targetBranch: string; expectedHeadSha: string; branch: string }) => api.integrateTask(projectId, taskId, b), onSettled: done }),
  }
}

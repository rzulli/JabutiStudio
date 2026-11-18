import { useCallback } from 'react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Task } from '@/hooks/useTasks'

/**
 * Start an AI session for a task: fetch the prompt, then ask the terminal
 * panel to open a tab running the chosen agent.
 *
 * Shared by the kanban and the command palette so both send the same event —
 * the panel is the only thing that knows how to create a session.
 */
export function useAiResolve() {
  const queryClient = useQueryClient()
  return useCallback(async (task: Task, options?: { feedback?: string; agent?: string; model?: string; effort?: string }) => {
    try {
      const { prompt } = await api.getAiResolvePrompt(task.projectId, task.id, options?.feedback)
      const agent = options?.agent || task.agent
      // The dialog always states model and effort (undefined = harness default); a straight run uses the task's own.
      const model = options && 'model' in options ? options.model : task.agentModel
      const effort = options && 'effort' in options ? options.effort : task.agentEffort
      window.dispatchEvent(new CustomEvent('shipyard:open-terminal', {
        detail: {
          projectId: task.projectId,
          type: 'ai-resolve',
          taskId: task.id,
          taskNumber: task.number,
          prompt,
          ...(agent ? { agent } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        },
      }))
      toast.success('AI resolution started')
      // The server moves the task to In Progress when the session opens;
      // give it a moment, then show it without waiting for the next poll.
      window.setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['tasks', task.projectId] })
        queryClient.invalidateQueries({ queryKey: ['tasks', 'all'] })
      }, 1500)
    } catch (err: any) {
      toast.error(err.message || 'Failed to start AI resolution')
    }
  }, [queryClient])
}

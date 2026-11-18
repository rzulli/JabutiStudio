import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useFileScope } from './useFileScope'

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  extension?: string
  mimeHint?: string
  /** Godot sidecar: listed for preview only, never written. */
  readOnly?: boolean
}

export interface FileContent {
  content: string
  encoding: string
  mimeHint: string
  size: number
}

export function useFileTree(projectId: string, relPath: string, enabled = true, includeSidecars = false) {
  const scope = useFileScope()
  return useQuery({
    queryKey: ['files', 'tree', projectId, relPath, includeSidecars, scope ?? ''],
    queryFn: () => api.getFileTree(projectId, relPath, includeSidecars, scope),
    enabled: !!projectId && enabled,
    staleTime: 10_000,
  })
}

export function useFileContent(projectId: string, relPath: string | null) {
  return useQuery({
    queryKey: ['files', 'content', projectId, relPath],
    queryFn: () => api.getFileContent(projectId, relPath!),
    enabled: !!projectId && !!relPath,
    // Files change on disk outside the app (editors, Claude Code) — always
    // refetch on mount so previews never show stale content.
    staleTime: 0,
    refetchOnMount: 'always',
  })
}

export function useDeleteFile() {
  const queryClient = useQueryClient()
  const scope = useFileScope()
  return useMutation({
    mutationFn: ({ projectId, relPath }: { projectId: string; relPath: string }) =>
      api.deleteFile(projectId, relPath, scope),
    onSuccess: (_data, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: ['files', 'tree', projectId] })
    },
  })
}

export function useOpenFileFolder() {
  return useMutation({
    mutationFn: ({ projectId, relPath }: { projectId: string; relPath: string }) =>
      api.openFileFolder(projectId, relPath),
  })
}

export function useRenameFile() {
  const queryClient = useQueryClient()
  const scope = useFileScope()
  return useMutation({
    mutationFn: ({ projectId, relPath, newName }: { projectId: string; relPath: string; newName: string }) =>
      api.renameFile(projectId, relPath, newName, scope),
    onSuccess: (_data, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: ['files', 'tree', projectId] })
    },
  })
}

export function useCreateFile() {
  const queryClient = useQueryClient()
  const scope = useFileScope()
  return useMutation({
    mutationFn: ({ projectId, parentPath, name, type }: { projectId: string; parentPath: string; name: string; type: 'file' | 'dir' }) =>
      api.createFile(projectId, parentPath, name, type, scope),
    onSuccess: (_data, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: ['files', 'tree', projectId] })
    },
  })
}

export function useCopyFile() {
  const queryClient = useQueryClient()
  const scope = useFileScope()
  return useMutation({
    mutationFn: ({ projectId, sourcePath, destParentPath, newName }: { projectId: string; sourcePath: string; destParentPath?: string; newName?: string }) =>
      api.copyFile(projectId, sourcePath, destParentPath, newName, scope),
    onSuccess: (_data, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: ['files', 'tree', projectId] })
    },
  })
}

/** `taskId` is explicit: a saved tab knows its own checkout, which need not be the one the tree shows now. */
export function useSaveFile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, relPath, content, taskId }: { projectId: string; relPath: string; content: string; taskId?: string }) =>
      api.saveFileContent(projectId, relPath, content, taskId),
    onSuccess: (_data, { projectId, relPath }) => {
      queryClient.invalidateQueries({ queryKey: ['files', 'content', projectId, relPath] })
    },
  })
}

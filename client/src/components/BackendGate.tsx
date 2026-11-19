import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Fired on window when the backend answers again after an outage. Components that hold their own sockets
 * (the terminal) listen for it, because their reconnect attempts run out while the backend is away.
 */
export const BACKEND_RECOVERED_EVENT = 'shipyard:backend-recovered'

const panelStyle = {
  display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center',
  height: '100vh', gap: '10px', fontFamily: 'system-ui, sans-serif', color: '#ccc', background: '#07090c',
}

/**
 * Holds the app until the backend answers. Nothing below mounts before that, so no query fires into a
 * server that is not listening yet. Once it has answered, the children stay mounted: a banner shows an
 * outage with its reason, and when the backend returns every query is refetched.
 *
 * The probe itself keeps retrying, paced by react-query's backoff; it never gives up and never hides the
 * failure, because the reason is shown on screen while it waits.
 */
export function BackendGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const probe = useQuery({
    queryKey: ['backend', 'readiness'],
    queryFn: () => api.identity(),
    retry: true,
    retryDelay: (failures) => Math.min(500 * 2 ** failures, 5000),
    // Once up, a heartbeat notices an outage even when no other query is running.
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    staleTime: 0,
  })

  const [ready, setReady] = useState(false)
  const confirmed = useRef(false)
  const wasDown = useRef(false)
  const reason = probe.failureReason?.message

  useEffect(() => {
    // A failing refetch keeps the last success, so check the failure count before the success flag.
    if (probe.failureCount > 0) {
      wasDown.current = true
      return
    }
    if (probe.isSuccess) {
      setReady(true)
      // Recovery only after an outage that the app already lived through; a cold start mounts its queries fresh.
      if (wasDown.current && confirmed.current) {
        window.dispatchEvent(new Event(BACKEND_RECOVERED_EVENT))
        void queryClient.invalidateQueries()
      }
      wasDown.current = false
      confirmed.current = true
    }
  }, [probe.isSuccess, probe.failureCount, probe.dataUpdatedAt, queryClient])

  if (!ready) {
    return (
      <div role="status" style={panelStyle}>
        <div style={{ fontSize: '14px' }}>Conectando ao backend…</div>
        <div style={{ fontSize: '12px', color: '#666', maxWidth: '460px', textAlign: 'center' }}>
          {reason ? `Último erro: ${reason}` : 'Aguardando o backend responder.'}
        </div>
      </div>
    )
  }

  return (
    <>
      {probe.failureCount > 0 && (
        <div role="status" style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000, padding: '6px 12px', textAlign: 'center',
          fontSize: '12px', color: '#fde68a', background: '#422006',
        }}>
          Backend indisponível — tentando reconectar automaticamente{reason ? `: ${reason}` : ''}
        </div>
      )}
      {children}
    </>
  )
}

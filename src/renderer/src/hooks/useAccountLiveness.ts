import { useEffect, useRef, useState } from 'react'
import type { AccountLivenessInput, AccountLivenessJob } from '../../../shared/accountLiveness'

export function useAccountLiveness() {
  const [job, setJob] = useState<AccountLivenessJob | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const current = useRef<AccountLivenessJob | null>(null)
  const locked = useRef(false)
  const mounted = useRef(false)
  const revision = useRef(0)

  const accept = (incoming: AccountLivenessJob | null) => {
    if (!mounted.current || !incoming) return
    const previous = current.current
    const progress = (value: AccountLivenessJob) => value.results.reduce((total, result) => total + (result.status === 'queued' ? 0 : result.status === 'running' ? 1 : 2), 0)
    if (previous && (incoming.startedAt < previous.startedAt || (incoming.id === previous.id && (
      incoming.updatedAt < previous.updatedAt ||
      progress(incoming) < progress(previous) ||
      (previous.state === 'cancelling' && incoming.state === 'running') ||
      (['completed', 'cancelled'].includes(previous.state) && ['running', 'cancelling'].includes(incoming.state))
    )))) return
    revision.current++
    current.current = incoming
    setJob(incoming)
  }

  useEffect(() => {
    mounted.current = true
    const api = window.electronAPI.accounts
    const unsubscribe = api.onLivenessChanged(accept)
    const version = revision.current
    // Restoring a report is read-only: opening this page never sends a test message.
    void api.livenessGet().then(value => {
      if (revision.current === version) accept(value)
    }).catch(() => { if (mounted.current) setError(true) })
    return () => { mounted.current = false; unsubscribe() }
  }, [])

  const start = async (input: AccountLivenessInput) => {
    if (locked.current || ['running', 'cancelling'].includes(current.current?.state || '')) return
    locked.current = true; setPending(true); setError(false)
    try { accept(await window.electronAPI.accounts.livenessStart(input)) }
    catch { if (mounted.current) setError(true) }
    finally { locked.current = false; if (mounted.current) setPending(false) }
  }

  const cancel = async () => {
    if (locked.current || current.current?.state !== 'running') return
    const id = current.current.id
    locked.current = true; setPending(true); setError(false)
    try { accept(await window.electronAPI.accounts.livenessCancel(id)) }
    catch { if (mounted.current) setError(true) }
    finally { locked.current = false; if (mounted.current) setPending(false) }
  }

  return { job, pending, error, busy: pending || job?.state === 'running' || job?.state === 'cancelling', start, cancel }
}

export type AccountLivenessController = ReturnType<typeof useAccountLiveness>

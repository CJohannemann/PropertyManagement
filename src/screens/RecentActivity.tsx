import { useEffect, useState } from 'react'
import { supabase, errorMessage } from '../lib/supabase'
import { timeAgo } from '../lib/notifications'
import { navigate, type Route } from '../lib/route'

type Activity = {
  kind: 'payment' | 'request' | 'job' | 'lease'
  happened_at: string
  title: string
  detail: string
  link: string | null
}

type Props = { organizationId: string }

/**
 * What has happened lately.
 *
 * Derived from the records themselves rather than an audit log. A log is a
 * second copy of the truth that can drift from it — a payment voided, a
 * request deleted, and the log still cheerfully says otherwise. Asking the
 * rows what happened means the feed cannot disagree with them.
 */
export function RecentActivity({ organizationId }: Props) {
  const [items, setItems] = useState<Activity[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    supabase
      .rpc('recent_activity', { org: organizationId, row_limit: 12 })
      .then(({ data, error }) => {
        if (error) setError(errorMessage(error))
        else setItems((data as Activity[]) ?? [])
      })
  }, [organizationId])

  if (error) {
    return <p className="muted">Recent activity couldn't load. ({error})</p>
  }
  if (items === null) return <p className="muted">Loading…</p>

  if (items.length === 0) {
    return (
      <p className="empty-state">
        Nothing has happened yet. Payments, repairs and new leases show up
        here as they do.
      </p>
    )
  }

  return (
    <div className="card-list">
      {items.map((a) => (
        <div
          key={`${a.kind}-${a.happened_at}-${a.detail}`}
          role={a.link ? 'button' : undefined}
          tabIndex={a.link ? 0 : undefined}
          onClick={() => a.link && navigate(a.link as Route)}
          onKeyDown={(e) => {
            if (a.link && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault()
              navigate(a.link as Route)
            }
          }}
          style={{ cursor: a.link ? 'pointer' : 'default' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
            <strong>{a.title}</strong>
            {/* Relative, because recency is what is being read: "3h ago"
                answers the question a timestamp makes you work out. */}
            <span className="muted" style={{ margin: 0, whiteSpace: 'nowrap' }}>
              {timeAgo(a.happened_at)}
            </span>
          </div>
          <div className="muted">{a.detail}</div>
        </div>
      ))}
    </div>
  )
}

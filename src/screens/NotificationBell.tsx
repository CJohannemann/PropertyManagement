import { useEffect, useState } from 'react'
import { errorMessage } from '../lib/supabase'
import {
  fetchNotifications, markAllRead, timeAgo, type Notification,
} from '../lib/notifications'
import { navigate, type Route } from '../lib/route'

type Props = { organizationId: string }

/**
 * The bell in the header, and the list behind it.
 *
 * This is the half of notifications that was missing: Web Push delivered
 * events already, but a push rings once and is gone. Someone whose phone
 * was face-down had no way to find out what they had missed.
 *
 * Opening the panel marks everything read — the count exists to say "there
 * is something you have not seen", and having looked, you have seen it.
 */
export function NotificationBell({ organizationId }: Props) {
  const [items, setItems] = useState<Notification[] | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reload() {
    fetchNotifications()
      .then(setItems)
      .catch((e) => setError(errorMessage(e)))
  }

  useEffect(reload, [organizationId])

  const unread = items?.filter((n) => !n.read_at).length ?? 0

  async function toggle() {
    const opening = !open
    setOpen(opening)
    if (opening && unread > 0) {
      try {
        await markAllRead(organizationId)
        // Cleared locally too, so the badge goes at once rather than on the
        // next load.
        setItems((prev) => prev?.map((n) => n.read_at ? n : { ...n, read_at: 'now' }) ?? prev)
      } catch (e) {
        setError(errorMessage(e))
      }
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        className="link"
        onClick={toggle}
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        style={{ fontSize: '1.1rem', lineHeight: 1 }}
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 && <span className="bell-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div className="notification-panel">
          {error && <p className="error-text">{error}</p>}
          {items === null && <p className="muted">Loading…</p>}
          {items?.length === 0 && (
            <p className="empty-state" style={{ padding: '0.75rem 0' }}>
              Nothing yet. Repairs reported and payments received show up here.
            </p>
          )}
          {items?.map((n) => (
            <div
              key={n.id}
              role={n.link ? 'button' : undefined}
              tabIndex={n.link ? 0 : undefined}
              onClick={() => {
                if (!n.link) return
                setOpen(false)
                navigate(n.link as Route)
              }}
              className="notification-row"
              style={{ cursor: n.link ? 'pointer' : 'default' }}
            >
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
                {/* Urgency is never color alone: high-priority rows say so
                    in their title, which the trigger writes. */}
                {n.urgency === 'high' && (
                  <span aria-hidden="true" style={{
                    width: 7, height: 7, borderRadius: '50%',
                    background: 'var(--danger)', flexShrink: 0,
                  }} />
                )}
                <strong style={{ fontSize: '0.9rem' }}>{n.title}</strong>
              </div>
              {n.body && <div className="muted">{n.body}</div>}
              <div className="muted" style={{ fontSize: '0.8rem' }}>
                {timeAgo(n.created_at)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

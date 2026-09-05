import { supabase } from './supabase'

export type Notification = {
  id: string
  kind: string
  urgency: 'low' | 'normal' | 'high'
  title: string
  body: string | null
  link: string | null
  read_at: string | null
  created_at: string
}

/**
 * The notification history.
 *
 * Separate from Web Push, which is delivery. A push rings once and is gone
 * — a phone face-down means the landlord never learns a thing happened —
 * so the row is written whether or not any push went out, and this is what
 * shows it. See db/migrations/023_notifications.sql.
 */
export async function fetchNotifications(limit = 30): Promise<Notification[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('notifications')
    .select('id, kind, urgency, title, body, link, read_at, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data as Notification[]) ?? []
}

export async function markAllRead(organizationId: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.rpc('mark_notifications_read', { org: organizationId })
  if (error) throw error
}

/** "just now", "3h ago", "yesterday" — relative, because that is how recency reads. */
export function timeAgo(iso: string, now = new Date()): string {
  const then = new Date(iso)
  const mins = Math.floor((now.getTime() - then.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return then.toLocaleDateString()
}

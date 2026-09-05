import { supabase } from './supabase'

export type PropertyRow = {
  id: string
  name: string
  units: number
  occupied: number
  vacant: number
  monthly_rent: number
  overdue: number
  open_maintenance: number
  urgent_maintenance: number
}

export type DashboardSummary = {
  portfolio: {
    properties: number
    units: number
    occupied: number
    vacant: number
    monthly_rent: number
  }
  properties: PropertyRow[]
  maintenance: {
    open: number
    urgent: number
    unassigned: number
    scheduled: number
    completed_this_month: number
  }
  rent: {
    overdue: number
    overdue_leases: number
    due_soon: number
    due_soon_leases: number
    outstanding: number
  }
  expiring_leases: {
    lease_id: string
    property_name: string
    unit_label: string
    end_date: string
  }[]
  top_request: {
    id: string
    category: string
    priority: string
    description: string
    property_name: string
    unit_label: string
    created_at: string
  } | null
}

/**
 * Everything the dashboard needs, in one request.
 *
 * The database returns figures, never sentences — the wording lives in the
 * components, where it can change without a migration.
 */
export async function fetchDashboard(organizationId: string): Promise<DashboardSummary | null> {
  if (!supabase) return null
  const { data, error } = await supabase.rpc('dashboard_summary', { org: organizationId })
  if (error) throw error
  return data as DashboardSummary
}

/** "Good morning" / "Good afternoon" / "Good evening", by the reader's own clock. */
export function greeting(now = new Date()): string {
  const h = now.getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

/** "Friday, 5 September" — the reader's local date, not a UTC one. */
export function todayLong(now = new Date()): string {
  return now.toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long',
  })
}

/** Whole days from today to an ISO date, by calendar date rather than elapsed hours. */
export function daysUntil(isoDate: string, now = new Date()): number {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number)
  // Both sides built as local midnight, so a lease ending tomorrow is 1 day
  // away at any hour — not 0 in the evening because 18 hours is under a day.
  const then = new Date(y, m - 1, d)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((then.getTime() - today.getTime()) / 86_400_000)
}

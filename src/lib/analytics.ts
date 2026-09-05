import { supabase } from './supabase'

export type RentMonth = {
  /** First day of the month, as YYYY-MM-DD. */
  month: string
  billed: number
  collected: number
  outstanding: number
}

/**
 * What was billed and what came in, month by month.
 *
 * Comes from rent_summary() rather than being totalled in the browser: it
 * is a security-definer function with its own role check, so one landlord
 * cannot ask for another's revenue, and it returns a row for every month
 * in the window including the quiet ones — a chart with gaps where a quiet
 * month should be reads as missing data rather than as a quiet month.
 */
export async function fetchRentSummary(
  organizationId: string,
  months = 12,
): Promise<RentMonth[]> {
  if (!supabase) return []
  const { data, error } = await supabase.rpc('rent_summary', {
    org: organizationId,
    month_count: months,
  })
  if (error) throw error
  // numeric arrives as a string, deliberately — see the note in
  // server/db.mjs about parsing money through floats. Coerced once here.
  return (data as RentMonth[] ?? []).map((m) => ({
    month: m.month,
    billed: Number(m.billed),
    collected: Number(m.collected),
    outstanding: Number(m.outstanding),
  }))
}

/**
 * "Sep" / "Sep 25" for a YYYY-MM-DD month.
 *
 * Split and rebuilt from the parts rather than passed through `new Date`:
 * `new Date('2026-09-01')` parses as UTC midnight and renders as August 31
 * anywhere west of Greenwich, which would put a whole month's rent under
 * the wrong label. Same bug class as the overdue one fixed in owed.ts.
 */
export function monthLabel(month: string, withYear = false): string {
  const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const [year, m] = month.split('-')
  const name = NAMES[Number(m) - 1] ?? month
  return withYear ? `${name} ${year.slice(2)}` : name
}

/** Share of billed rent that has been collected, 0–1. Zero billed is fully collected. */
export function collectionRate(m: { billed: number; collected: number }): number {
  if (m.billed <= 0) return 1
  return Math.min(m.collected / m.billed, 1)
}

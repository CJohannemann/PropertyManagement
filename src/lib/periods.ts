/**
 * Reporting periods, and the calendar dates they mean.
 *
 * Import-free like owed.ts and routePaths.ts: analytics.ts reaches for
 * Supabase and cannot be loaded by a Node test, and these are date rules,
 * which is exactly the kind of thing that goes quietly wrong.
 */

/** The periods the spec asks for. `custom` carries its own dates. */
export type PeriodKey = 'this_month' | 'last_month' | 'ytd' | 'custom'

export const PERIOD_OPTIONS: { value: PeriodKey; label: string }[] = [
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'custom', label: 'Custom range' },
]

const iso = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * The date range a period means, as local calendar dates.
 *
 * Built from year/month/day parts rather than through UTC, for the reason
 * owed.ts carries a warning about: a range built from UTC midnights starts
 * a day early west of Greenwich, which would pull the last day of the
 * previous month into "this month" and put that rent in the wrong bucket.
 *
 * `new Date(y, m + 1, 0)` is day zero of the next month — the last day of
 * this one — so February is 28 or 29 without anyone having to know which.
 */
export function periodRange(
  period: PeriodKey,
  custom?: { from: string; to: string },
  today = new Date(),
): { from: string; to: string } {
  const y = today.getFullYear()
  const m = today.getMonth()

  switch (period) {
    case 'last_month':
      return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) }
    case 'ytd':
      return { from: iso(new Date(y, 0, 1)), to: iso(today) }
    case 'custom':
      return custom?.from && custom?.to
        ? custom
        // An incomplete custom range falls back to this month rather than
        // querying a span the user has not finished describing.
        : { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) }
    case 'this_month':
    default:
      // To the end of the month, not to today: "expected this month"
      // includes rent due on the 28th when it is only the 3rd.
      return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) }
  }
}

/**
 * What is still owed on a charge, and whether it is late.
 *
 * Deliberately import-free, like leaseDates.ts and splitClauses.ts: these
 * are the rules that decide whether a tenant is told they are behind on
 * rent, so they need to be testable directly rather than only through a
 * module that reaches for the network. db/test/overdue.mjs exercises them.
 *
 * Structurally typed rather than importing Charge, which would drag
 * charges.ts (and Supabase) back in. Any charge row satisfies this.
 */
export type Owing = {
  due_date: string
  amount: number
  amount_paid: number
}

export function outstanding(c: Owing): number {
  return Math.max(Number(c.amount) - Number(c.amount_paid), 0)
}

export function totalOutstanding(charges: Owing[]): number {
  return charges.reduce((sum, c) => sum + outstanding(c), 0)
}

/** Today where the person is standing, as YYYY-MM-DD. */
function todayLocal(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Whether a charge is actually overdue today. Derived from the date rather
 * than read off `status`: a partly-paid charge stays 'partial' past its due
 * date (more informative than overwriting it with 'late'), so status alone
 * would under-report what is overdue. See mark_overdue_charges() in
 * db/migrations/002_rent_billing.sql.
 *
 * Compared as date STRINGS, not Dates. This previously read
 *
 *   new Date(c.due_date) < new Date(new Date().toDateString())
 *
 * where the left side parses an ISO date as UTC midnight and the right
 * parses a local date string as LOCAL midnight. Anywhere west of
 * Greenwich the left is smaller by exactly the UTC offset, so every
 * charge showed as overdue from midnight on the day it fell due — a
 * Kentucky tenant was told they were late on the day they were asked to
 * pay. Invisible in UTC, which is what the VPS and every test box run in.
 *
 * Both sides are now plain calendar dates, which is what a due date is.
 * ISO dates sort correctly as text, so `<` still means "before".
 */
export function isOverdue(c: Owing): boolean {
  return outstanding(c) > 0 && c.due_date < todayLocal()
}

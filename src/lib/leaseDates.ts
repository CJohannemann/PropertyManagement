/**
 * Date and proration arithmetic for leases.
 *
 * Pure functions in their own file rather than inside LeaseForm, so they
 * can be tested directly — see db/test/proration-parity.mjs, which checks
 * them against the SQL implementation using the same cases.
 *
 * Everything here builds dates in UTC and from the date string's own
 * parts. Parsing "2026-09-01" as local time puts it at midnight UTC,
 * which is the previous day for anyone west of UTC — enough to shift a
 * lease end date by a day and change a proration by one day's rent.
 */

/**
 * Rent owed for the partial period a lease starts in.
 *
 * Mirrors prorated_first_period() in
 * db/migrations/010_prorated_rent.sql. Duplicated deliberately so the
 * figure appears as the landlord types rather than after a round trip;
 * db/test/02-proration.test.sql pins the SQL side, and the parity check
 * keeps the two honest.
 *
 * The period runs between rent due days, not between calendar months:
 * rent due on the 15th with a term starting the 20th owes the 20th
 * through the 14th of the following month. Returns 0 when the lease
 * starts on the due day — a whole period is owed then, billed as ordinary
 * rent, and prorating as well would charge it twice.
 */
export function proratedFirstPeriod(
  startIso: string,
  rentDueDay: number,
  rentAmount: number,
): number | null {
  if (!startIso || !rentDueDay || !rentAmount) return null
  const [y, m, d] = startIso.split('-').map(Number)
  if (!y || !m || !d) return null

  const DAY = 86_400_000
  const start = Date.UTC(y, m - 1, d)

  // The due day on or before the start date opens the period the lease
  // begins inside; if that lands after the start, the period opened in the
  // previous month.
  let periodStart = Date.UTC(y, m - 1, rentDueDay)
  if (periodStart > start) periodStart = Date.UTC(y, m - 2, rentDueDay)

  const next = new Date(periodStart)
  next.setUTCMonth(next.getUTCMonth() + 1)
  const periodEnd = next.getTime() - DAY

  const daysIn = Math.round((periodEnd - periodStart) / DAY) + 1
  const daysOwed = Math.round((periodEnd - start) / DAY) + 1

  if (daysOwed >= daysIn) return 0
  return Math.round((rentAmount * daysOwed / daysIn) * 100) / 100
}

/**
 * The end date of a standard 12-month term: a lease starting 2026-09-01
 * runs through 2027-08-31, not 2027-09-01 — the last day of the twelfth
 * month, not the first day of the thirteenth. A Feb 29 start lands on
 * Feb 28 the following year, which is the right answer.
 */
export function oneYearTerm(startIso: string): string {
  const [y, m, d] = startIso.split('-').map(Number)
  if (!y || !m || !d) return ''
  const end = new Date(Date.UTC(y + 1, m - 1, d))
  end.setUTCDate(end.getUTCDate() - 1)
  return end.toISOString().slice(0, 10)
}

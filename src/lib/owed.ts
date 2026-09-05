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

/**
 * Where a charge stands, in words meant for the person reading them.
 *
 * The screens used to print rent_charges.status directly, so a landlord
 * was shown 'pending' — a database word that says nothing about whether
 * to worry. Worse, it is the same word for "due in three weeks" and "due
 * today and unpaid", which are not the same situation at all.
 *
 * Derived rather than switched on `status` for the same reason isOverdue
 * is: a part-paid charge stays 'partial' past its due date, so the stored
 * status alone under-reports what is actually late.
 */
export function statusLabel(c: Owing): string {
  if (outstanding(c) === 0) return 'Paid'
  if (isOverdue(c)) return 'Overdue'
  if (Number(c.amount_paid) > 0) return 'Part paid'
  if (c.due_date === todayLocal()) return 'Due today'
  return 'Upcoming'
}

// ------------------------------------------------- grouping by building --

/** The nesting a charge arrives with, structurally. */
export type Placed = Owing & {
  id: string
  leases?: {
    units?: {
      id: string
      label: string
      properties?: { id: string; name: string } | null
    } | null
  } | null
}

export type UnitGroup<T extends Placed> = {
  id: string
  label: string
  owed: number
  charges: T[]
}

export type PropertyGroup<T extends Placed> = {
  id: string
  name: string
  owed: number
  unitCount: number
  units: UnitGroup<T>[]
  charges: T[]
}

/**
 * Buckets charges into buildings, then units within them, summing what is
 * owed at each level.
 *
 * Lives here with the rest of the money rules rather than in the screen
 * that renders it, so the sums can be tested — RentStatus.tsx reaches for
 * Supabase and cannot be imported by a test. These totals are what a
 * landlord reads to decide who to chase, so "the arithmetic is obviously
 * right" is not good enough.
 *
 * Keyed by id rather than name throughout: two buildings in one
 * organization can share a name, and merging their money into one row
 * would be a reporting error nobody would spot.
 */
export type MonthCell = {
  /** YYYY-MM. */
  month: string
  billed: number
  collected: number
  /** No charge was billed for this unit that month at all. */
  empty: boolean
}

/**
 * The last `count` months for one unit, oldest first, with a cell for every
 * month whether or not anything was billed.
 *
 * Bucketed on the due date's YEAR AND MONTH TEXT, sliced straight off the
 * date string — never through `new Date`. `new Date('2026-09-01')` parses
 * as UTC midnight and is August 31st anywhere west of Greenwich, which
 * would file a whole month's rent under the previous month for a landlord
 * in Kentucky. Same bug class as the overdue one this module already
 * carries a warning about.
 */
/**
 * The YYYY-MM `count` months back from `today`, counting today's month as
 * the first.
 *
 * Walks a year/month pair rather than subtracting from a Date: subtracting
 * a month from 31 March lands on 3 March, which would drop February out of
 * a run of months entirely.
 */
export function monthsBack(count: number, today = new Date()): string {
  const total = today.getFullYear() * 12 + today.getMonth() - (count - 1)
  const month = String((total % 12) + 1).padStart(2, '0')
  return `${Math.floor(total / 12)}-${month}`
}

export function monthlyHistory(
  charges: Owing[],
  count = 12,
  today = new Date(),
): MonthCell[] {
  const months: string[] = []
  for (let i = count; i >= 1; i--) months.push(monthsBack(i, today))

  const billed = new Map<string, { billed: number; collected: number }>()
  for (const c of charges) {
    const key = c.due_date.slice(0, 7)
    const bucket = billed.get(key) ?? { billed: 0, collected: 0 }
    bucket.billed += Number(c.amount)
    bucket.collected += Number(c.amount_paid)
    billed.set(key, bucket)
  }

  return months.map((month) => {
    const bucket = billed.get(month)
    return {
      month,
      billed: bucket?.billed ?? 0,
      collected: bucket?.collected ?? 0,
      empty: !bucket,
    }
  })
}

export function groupByProperty<T extends Placed>(charges: T[]): PropertyGroup<T>[] {
  const byProperty = new Map<string, PropertyGroup<T>>()

  for (const c of charges) {
    const unit = c.leases?.units
    // A charge whose lease or unit was deleted still has money attached to
    // it and must not vanish from the totals; it collects under a heading
    // saying so rather than being dropped.
    const propertyId = unit?.properties?.id ?? 'unknown'
    const propertyName = unit?.properties?.name ?? 'Unknown property'
    const unitId = unit?.id ?? 'unknown'
    const unitLabel = unit?.label ?? 'Unknown unit'

    let property = byProperty.get(propertyId)
    if (!property) {
      property = {
        id: propertyId, name: propertyName, owed: 0, unitCount: 0, units: [], charges: [],
      }
      byProperty.set(propertyId, property)
    }
    property.charges.push(c)
    property.owed += outstanding(c)

    let unitGroup = property.units.find((u) => u.id === unitId)
    if (!unitGroup) {
      unitGroup = { id: unitId, label: unitLabel, owed: 0, charges: [] }
      property.units.push(unitGroup)
    }
    unitGroup.charges.push(c)
    unitGroup.owed += outstanding(c)
  }

  for (const property of byProperty.values()) {
    property.unitCount = property.units.length
    // Within a building, the unit owing most comes first; settled units
    // sink. Same reasoning as the building order below.
    property.units.sort((a, b) => b.owed - a.owed || a.label.localeCompare(b.label))
  }

  // Buildings that owe money first, largest debt first — at a hundred doors
  // this is what makes the screen usable, since the top of the list is
  // always the work. Fully settled buildings keep their place
  // alphabetically below, so a landlord can still confirm one is clear.
  return [...byProperty.values()].sort(
    (a, b) => b.owed - a.owed || a.name.localeCompare(b.name),
  )
}

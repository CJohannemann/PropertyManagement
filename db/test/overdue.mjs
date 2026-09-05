#!/usr/bin/env node
//
// isOverdue(), checked across timezones.
//
//   npm run verify:overdue
//
// This exists because of a bug found in real use: a Kentucky landlord's
// dashboard showed rent as "Overdue" on the day it fell due. The old
// implementation compared
//
//   new Date(c.due_date)  <  new Date(new Date().toDateString())
//
// where the left side parses an ISO date as UTC midnight and the right
// parses a local date string as LOCAL midnight. Anywhere west of
// Greenwich the left is the smaller by exactly the UTC offset, so a
// charge due today read as overdue from midnight onwards.
//
// Runs each case under several timezones, because the bug is invisible in
// UTC — which is what a CI box and a VPS both default to, and why nothing
// caught it.

import {
  isOverdue, statusLabel, groupByProperty, monthlyHistory,
} from '../../src/lib/owed.ts'

const ZONES = [
  'UTC',
  'America/New_York',   // where this app's first landlord actually is
  'America/Los_Angeles',// furthest behind in the lower 48
  'Pacific/Kiritimati', // UTC+14, the other extreme
]

const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function daysFromToday(n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return iso(d)
}

const charge = (due, amount = 1200, paid = 0) => ({
  id: 'x', lease_id: 'y', charge_type: 'rent',
  due_date: due, amount, amount_paid: paid, status: 'pending',
})

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`  ${ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}`)
  if (!ok) console.log(`        expected ${expected}, got ${actual}`)
}

// process.env.TZ is read by Date on each call, so this can be flipped
// between cases rather than needing a subprocess per zone.
for (const zone of ZONES) {
  process.env.TZ = zone
  console.log(`\n${zone}`)

  check('a charge due today is not overdue', isOverdue(charge(daysFromToday(0))), false)
  check('a charge due tomorrow is not overdue', isOverdue(charge(daysFromToday(1))), false)
  check('a charge due next month is not overdue', isOverdue(charge(daysFromToday(30))), false)
  check('a charge due yesterday is overdue', isOverdue(charge(daysFromToday(-1))), true)
  check('a charge due last month is overdue', isOverdue(charge(daysFromToday(-30))), true)

  // Paid off, however late, is not owed — overdue is about money still
  // outstanding, not about the date alone.
  check('a fully paid past charge is not overdue',
    isOverdue(charge(daysFromToday(-30), 1200, 1200)), false)
  check('a part-paid past charge is still overdue',
    isOverdue(charge(daysFromToday(-30), 1200, 400)), true)

  // The wording a landlord and a tenant actually read. 'Due today' and
  // 'Upcoming' were both 'pending' before, which said nothing about
  // whether to worry.
  check('due today reads as due today',
    statusLabel(charge(daysFromToday(0))), 'Due today')
  check('due later reads as upcoming',
    statusLabel(charge(daysFromToday(14))), 'Upcoming')
  check('past and unpaid reads as overdue',
    statusLabel(charge(daysFromToday(-1))), 'Overdue')
  check('settled reads as paid',
    statusLabel(charge(daysFromToday(-5), 1200, 1200)), 'Paid')
  check('part paid and not yet due reads as part paid',
    statusLabel(charge(daysFromToday(5), 1200, 400)), 'Part paid')
  // Overdue beats part-paid: money still owed past its date is the more
  // urgent fact.
  check('part paid and overdue still reads as overdue',
    statusLabel(charge(daysFromToday(-5), 1200, 400)), 'Overdue')
}

// ------------------------------------------- grouping rent by building --
//
// The rent status screen sums money per building and per unit. A landlord
// reads those totals to decide who to chase, so the arithmetic is checked
// rather than eyeballed.

process.env.TZ = 'America/New_York'
console.log('\ngrouping by building')

const placed = (id, propId, propName, unitId, unitLabel, amount, paid = 0, due = daysFromToday(0)) => ({
  id, due_date: due, amount, amount_paid: paid, charge_type: 'rent',
  leases: { units: { id: unitId, label: unitLabel, properties: { id: propId, name: propName } } },
})

const groups = groupByProperty([
  placed('c1', 'p1', 'Central', 'u1', '2 - Middle', 1200),
  placed('c2', 'p1', 'Central', 'u1', '2 - Middle', 1080),
  placed('c3', 'p1', 'Central', 'u2', '1 - Bottom', 500, 500), // settled
  placed('c4', 'p2', 'Riverside', 'u3', 'A', 900, 400),        // part paid
  placed('c5', 'p3', 'Alder', 'u4', 'A', 300, 300),            // all paid
])

check('one group per building', groups.length, 3)
check('the building owing most sorts first', groups[0].name, 'Central')
check('its total is the sum of what is outstanding', groups[0].owed, 2280)
check('a part-paid building counts only the remainder', groups[1].owed, 500)
check('a fully settled building sorts last', groups[2].name, 'Alder')
check('and owes nothing', groups[2].owed, 0)

check('units are grouped within a building', groups[0].units.length, 2)
check('the unit owing most comes first', groups[0].units[0].label, '2 - Middle')
check('unit totals sum their own charges', groups[0].units[0].owed, 2280)
check('a settled unit is kept, not dropped', groups[0].units[1].owed, 0)
check('every charge is still accounted for', groups[0].charges.length, 3)

// Two buildings sharing a name must not have their money merged — the
// reason this groups by id rather than by name.
const sameName = groupByProperty([
  placed('c1', 'p1', 'Main St', 'u1', 'A', 1000),
  placed('c2', 'p2', 'Main St', 'u2', 'B', 250),
])
check('two buildings with the same name stay separate', sameName.length, 2)
check('and keep their own totals', [sameName[0].owed, sameName[1].owed].join(), '1000,250')

// A charge whose lease or unit was deleted still has money attached to it.
const orphan = groupByProperty([
  { id: 'c9', due_date: daysFromToday(0), amount: 750, amount_paid: 0, leases: null },
])
check('an orphaned charge is not silently dropped', orphan.length, 1)
check('its money still counts', orphan[0].owed, 750)
check('and it says so', orphan[0].name, 'Unknown property')

// -------------------------------------------- a unit's month-by-month --
//
// Run under every timezone, because the failure this guards against is
// exactly the one already fixed once in this file: a date parsed through
// `new Date` lands a month early west of Greenwich, filing September's
// rent under August.

for (const zone of ZONES) {
  process.env.TZ = zone
  console.log(`\nmonthly history — ${zone}`)

  const march = new Date(2026, 2, 15) // 15 March 2026, local
  const history = monthlyHistory(
    [
      { due_date: '2026-03-01', amount: 1000, amount_paid: 1000 },
      { due_date: '2026-02-01', amount: 1000, amount_paid: 400 },
      { due_date: '2026-01-01', amount: 1000, amount_paid: 0 },
    ],
    12,
    march,
  )

  check('returns one cell per month', history.length, 12)
  check('oldest first', history[0].month, '2025-04')
  check('ending with the month asked about', history[11].month, '2026-03')

  const march2026 = history.find((h) => h.month === '2026-03')
  check('a charge due the 1st lands in its own month, not the previous one',
    march2026.billed, 1000)
  check('and its payment with it', march2026.collected, 1000)

  check('a part-paid month keeps both figures',
    history.find((h) => h.month === '2026-02').collected, 400)
  check('an unpaid month collects nothing',
    history.find((h) => h.month === '2026-01').collected, 0)
  check('a month with no charge is marked empty',
    history.find((h) => h.month === '2025-12').empty, true)
  check('a month with a charge is not',
    history.find((h) => h.month === '2026-01').empty, false)
}

// Walking year/month rather than subtracting from a Date: "one month
// before 31 March" is 3 March if you subtract days, which would drop
// February from the strip entirely.
process.env.TZ = 'America/New_York'
console.log('\nmonthly history — month-end')
const fromMar31 = monthlyHistory([], 3, new Date(2026, 2, 31))
check('a run ending on the 31st still walks whole months',
  fromMar31.map((h) => h.month).join(), '2026-01,2026-02,2026-03')

console.log(
  failures === 0
    ? '\n\x1b[32mAll overdue tests passed.\x1b[0m'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`,
)
process.exit(failures === 0 ? 0 : 1)

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

import { isOverdue } from '../../src/lib/owed.ts'

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
}

console.log(
  failures === 0
    ? '\n\x1b[32mAll overdue tests passed.\x1b[0m'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`,
)
process.exit(failures === 0 ? 0 : 1)

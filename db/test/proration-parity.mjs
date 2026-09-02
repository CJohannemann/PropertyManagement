#!/usr/bin/env node
//
// The proration figure is calculated twice: in SQL
// (prorated_first_period, so billing is correct regardless of client) and
// in TypeScript (src/lib/leaseDates.ts, so the number appears as the
// landlord types rather than after a round trip).
//
// Two implementations of the same money calculation is a liability unless
// something proves they agree. This runs the TypeScript one over the same
// cases db/test/02-proration.test.sql pins for SQL. If they ever diverge,
// this fails rather than one landlord's lease quietly billing a different
// amount than the form promised.
//
//   node --experimental-strip-types db/test/proration-parity.mjs

import { proratedFirstPeriod } from '../../src/lib/leaseDates.ts'

const r = (n) => Math.round(n * 100) / 100

const cases = [
  ['2025-07-25',  1, 1200, 270.97,          'the real lease: July 25 start, due 1st'],
  ['2026-01-01',  1, 1200, 0,               'starting on the due day owes nothing extra'],
  ['2026-02-28',  1, 1200, r(1200 * 1 / 28), 'one day of a 28-day period'],
  ['2026-07-31',  1, 1200, r(1200 * 1 / 31), 'one day of a 31-day period'],
  ['2026-01-20', 15, 3100, r(3100 * 26 / 31), 'due 15th, starting 20th: 26 of 31 days'],
  ['2026-01-02',  1, 1200, r(1200 * 30 / 31), 'day after the due day'],
  ['2026-01-31',  1, 1200, r(1200 * 1 / 31), 'last day of the period'],
  ['2028-02-15',  1, 1160, r(1160 * 15 / 29), 'leap February is 29 days'],
]

let failed = 0
for (const [start, due, rent, expected, label] of cases) {
  const got = proratedFirstPeriod(start, due, rent)
  const ok = got === expected
  if (!ok) failed++
  console.log(`  ${ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}` +
    (ok ? '' : `  (expected ${expected}, got ${got})`))
}

// A short month's day is worth more than a long month's, which is the
// whole reason for dividing by the real period length.
if (!(proratedFirstPeriod('2026-02-28', 1, 1200) > proratedFirstPeriod('2026-07-31', 1, 1200))) {
  console.log('  \x1b[31mFAIL\x1b[0m  a day of February should cost more than a day of July')
  failed++
}

for (const [args, label] of [
  [[null, 1, 1200], 'null start date'],
  [['2026-01-15', null, 1200], 'null due day'],
  [['2026-01-15', 1, null], 'null rent'],
]) {
  if (proratedFirstPeriod(...args) !== null) {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label} should yield null`)
    failed++
  }
}

console.log(failed === 0
  ? '\x1b[32m\nProration matches between TypeScript and SQL.\x1b[0m'
  : `\x1b[31m\n${failed} mismatch(es).\x1b[0m`)
process.exit(failed === 0 ? 0 : 1)

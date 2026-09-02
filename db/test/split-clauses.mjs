#!/usr/bin/env node
//
// Splitting a pasted lease into clauses.
//
// Heuristics on unstructured text, so the failure mode that matters is
// not "missed a heading" — that costs a few seconds of tidying — but
// splitting a clause in half at a numbered list, which quietly separates
// terms from the clause that governs them.
//
//   node --experimental-strip-types db/test/split-clauses.mjs

import { splitIntoClauses } from '../../src/lib/splitClauses.ts'

// Shaped like a real lease: numbered all-caps headings, prose beneath, and
// a numbered list buried inside one clause.
const sample = `1. GENERAL INFORMATION

1.1 DATE

The date of this Agreement is 07/22/2025.

1.2 TENANT(S)

The Tenant(s) herein is/are named below. If more than one person is named
as Tenant, all persons named shall have joint and several liability.

2.1 LATE RENT

Rent is due in full on the Due Date. If Rent is not received on or before
the 1st, a one-time initial fee of $25 will be applied 5 days after the
rent due date. Tenant shall then pay the following amounts:
1. the unpaid rent
2. any accrued late fees
All late fees shall be deemed additional rent for the month.

Governing Law

This Agreement is governed by the laws of Kentucky.`

const out = splitIntoClauses(sample)
const headings = out.map((c) => c.heading)
const body = (h) => out.find((c) => c.heading === h)?.body ?? ''

let failed = 0
const check = (cond, what) => {
  console.log(`  ${cond ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${what}`)
  if (!cond) failed++
}

check(headings.includes('DATE'), 'finds a decimal-numbered heading (1.1 DATE)')
check(headings.includes('TENANT(S)'), 'finds a heading containing punctuation')
check(headings.includes('LATE RENT'), 'finds 2.1 LATE RENT')
check(headings.includes('Governing Law'), 'finds an unnumbered title-case heading')

// The important one: a numbered list inside a clause is not a set of
// headings, and splitting there would detach the terms from the clause.
check(!headings.some((h) => h.toLowerCase().includes('unpaid rent')),
  'does not treat a numbered list inside a clause as headings')
check(body('LATE RENT').includes('the unpaid rent')
   && body('LATE RENT').includes('any accrued late fees'),
  'the list stays inside the clause that governs it')
check(body('LATE RENT').includes('additional rent for the month'),
  'text after the list stays with it too')

check(body('DATE').includes('07/22/2025'), 'body follows its heading')
check(out.length === 4, `produced ${out.length} clauses (DATE, TENANT(S), LATE RENT, Governing Law — the "1. GENERAL INFORMATION" section title is absorbed, not emitted as an empty clause)`)

// Text with no headings at all must survive rather than vanish.
const plain = splitIntoClauses('Just one paragraph of a lease with no headings.')
check(plain.length === 1 && plain[0].body.startsWith('Just one paragraph'),
  'unheaded text becomes a single clause rather than being dropped')

check(splitIntoClauses('').length === 0, 'empty input produces nothing')

console.log(failed === 0
  ? '\x1b[32m\nClause splitting behaves.\x1b[0m'
  : `\x1b[31m\n${failed} failed.\x1b[0m`)
process.exit(failed === 0 ? 0 : 1)

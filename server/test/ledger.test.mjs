#!/usr/bin/env node
//
// Drives server/ledger.mjs — the code the Stripe webhook actually runs —
// against a real Postgres loaded with the real schema and migrations.
//
//   npm run verify:ledger
//
// Why this exists separately from db/test/08-payments.test.sql: that file
// proves the database triggers are right when a payment row changes. This
// one proves the code that changes those rows is right — the upsert, the
// out-of-order guard, the reconciliation check. Between them, a settled
// ACH payment credits the ledger exactly once no matter how many times,
// or in what order, Stripe delivers the news.
//
// The database comes from ./testdb.mjs, shared with api.test.mjs.

import { startTestDb, red, green } from './testdb.mjs'

const CONTAINER = 'pm-ledger-test-db'
const PORT = 5434
let psql = () => { throw new Error('database not started') }
let stopDb = () => {}

// Fixed ids so the assertions can refer to them without a round trip.
const ORG = '00000000-0000-0000-0000-0000000000a1'
const USER = '00000000-0000-0000-0000-0000000000b1'
const MEMBER = '00000000-0000-0000-0000-0000000000c1'
const LEASE = '00000000-0000-0000-0000-0000000000d1'
const CHARGE = '00000000-0000-0000-0000-0000000000e1'

function seedFixture() {
  psql(`
    insert into auth.users (id, email) values ('${USER}', 'tenant@example.com');
    insert into organizations (id, name) values ('${ORG}', 'Test Org');
    insert into properties (id, organization_id, name, address_line1, city, state, zip)
      values ('${ORG}', '${ORG}', 'H', '1 St', 'Covington', 'KY', '41051');
    insert into units (id, property_id, label) values ('${ORG}', '${ORG}', 'A');
    insert into leases (id, unit_id, start_date, rent_amount, rent_due_day, status)
      values ('${LEASE}', '${ORG}', '2026-01-01', 1200, 1, 'active');
    insert into org_members (id, organization_id, user_id, role, status)
      values ('${MEMBER}', '${ORG}', '${USER}', 'tenant', 'active');
    insert into lease_tenants (lease_id, org_member_id, is_primary)
      values ('${LEASE}', '${MEMBER}', true);
    insert into rent_charges (id, lease_id, charge_type, due_date, amount)
      values ('${CHARGE}', '${LEASE}', 'rent', '2026-02-01', 1200);
  `)
}

/** What the ledger currently says about the test charge. */
function chargeState() {
  const [paid, status] = psql(
    `select amount_paid, status from rent_charges where id = '${CHARGE}';`,
  ).trim().split('|')
  return { paid: Number(paid), status }
}

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${ok ? green('pass') : red('FAIL')}  ${label}`)
  if (!ok) {
    failures++
    console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

/** A Stripe PaymentIntent as our own /api/payments/intent would have made it. */
function intent(id, rentCents, feeCents) {
  return {
    id,
    amount: rentCents + feeCents,
    metadata: {
      rent_charge_id: CHARGE,
      lease_id: LEASE,
      tenant_member_id: MEMBER,
      rent_amount_cents: String(rentCents),
      processing_fee_cents: String(feeCents),
    },
  }
}

async function main() {
  const db = startTestDb({ container: CONTAINER, port: PORT })
  psql = db.psql
  stopDb = db.stop
  seedFixture()

  // Point the API's pool at this container before importing anything that
  // reads config.
  process.env.API_DATABASE_URL = db.url
  process.env.APP_URL = 'https://example.com'
  process.env.JWT_SECRET = 'test'
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy'

  const { upsertPayment, reversePayment } = await import('../ledger.mjs')
  const { close } = await import('../db.mjs')

  const pi = intent('pi_test_1', 120000, 600)

  console.log('\nan ACH payment settling')
  await upsertPayment(pi, 'processing')
  check('money in transit credits nothing', chargeState(), { paid: 0, status: 'pending' })

  await upsertPayment(pi, 'succeeded', { chargeId: 'ch_1' })
  check('settlement credits the rent', chargeState(), { paid: 1200, status: 'paid' })

  console.log('\nStripe redelivering the same news')
  await upsertPayment(pi, 'succeeded', { chargeId: 'ch_1' })
  await upsertPayment(pi, 'succeeded', { chargeId: 'ch_1' })
  check('a replayed settlement credits nothing further', chargeState(), { paid: 1200, status: 'paid' })

  console.log('\nevents arriving out of order')
  await upsertPayment(pi, 'processing')
  check('a late "processing" cannot un-settle a payment', chargeState(), { paid: 1200, status: 'paid' })

  console.log('\nthe bank returning the debit weeks later')
  await reversePayment('pi_test_1', 'disputed: insufficient_funds')
  check('a dispute reverses the credit', chargeState(), { paid: 0, status: 'pending' })

  await reversePayment('pi_test_1', 'disputed: insufficient_funds')
  check('reversing twice reverses once', chargeState(), { paid: 0, status: 'pending' })

  await upsertPayment(pi, 'succeeded', { chargeId: 'ch_1' })
  check('and a redelivered success cannot resurrect it', chargeState(), { paid: 0, status: 'pending' })

  console.log('\na split that does not add up')
  const tampered = intent('pi_test_2', 120000, 600)
  tampered.amount = 500 // as if the charged total had been altered
  let threw = false
  try {
    await upsertPayment(tampered, 'succeeded')
  } catch {
    threw = true
  }
  check('a payment that does not reconcile is refused', threw, true)
  check('and nothing is written for it', chargeState(), { paid: 0, status: 'pending' })

  console.log('\na payment this app did not create')
  const foreign = { id: 'pi_foreign', amount: 5000, metadata: {} }
  const result = await upsertPayment(foreign, 'succeeded')
  check('is ignored rather than recorded', result, { recorded: false })

  await close()

  console.log(failures === 0 ? green('\nAll ledger tests passed.') : red(`\n${failures} check(s) failed.`))
  return failures === 0 ? 0 : 1
}

let code = 1
try {
  code = await main()
} catch (err) {
  console.error(red(`\n${err.message}`))
} finally {
  stopDb()
}
process.exit(code)

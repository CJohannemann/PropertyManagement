#!/usr/bin/env node
//
// Drives the payments API over HTTP, the way a browser and Stripe do,
// against a real Postgres.
//
//   npm run verify:api
//
// ledger.test.mjs proves what the webhook writes. This proves what stands
// in front of those writes: that an unsigned webhook is refused, that a
// request with no session or a forged one is refused, and that every route
// works out the caller's authority from the database rather than from what
// the request says. This server connects as `postgres`, so row-level
// security does not apply here — these checks are the only ones there are.
//
// Stripe itself is never called. Its network methods are replaced with
// stand-ins that record what they were asked; signatures are made with
// the Stripe library's own test helper, against the same secret the server
// verifies with.

import jwt from 'jsonwebtoken'
import { startTestDb, red, green } from './testdb.mjs'

const CONTAINER = 'pm-api-test-db'
const PORT = 5435
const JWT_SECRET = 'test-jwt-secret'
const WEBHOOK_SECRET = 'whsec_test_api'

// Fixed ids so fixtures and assertions can refer to them directly.
const ORG = '00000000-0000-0000-0000-00000000a001'
const ORG_B = '00000000-0000-0000-0000-00000000a002'
const ORG_UNPAYABLE = '00000000-0000-0000-0000-00000000a003'
const ADMIN = '00000000-0000-0000-0000-00000000b001'
const PM = '00000000-0000-0000-0000-00000000b002'
const TENANT = '00000000-0000-0000-0000-00000000b003'
const NEIGHBOUR = '00000000-0000-0000-0000-00000000b004'
const ADMIN_B = '00000000-0000-0000-0000-00000000b005'
const DISABLED = '00000000-0000-0000-0000-00000000b006'
const TENANT_MEMBER = '00000000-0000-0000-0000-00000000c003'
const LEASE = '00000000-0000-0000-0000-00000000d001'
const LEASE_TENANT_PAYS = '00000000-0000-0000-0000-00000000d002'
const LEASE_UNPAYABLE = '00000000-0000-0000-0000-00000000d003'
const CHARGE = '00000000-0000-0000-0000-00000000e001'
const CHARGE_PAID = '00000000-0000-0000-0000-00000000e002'
const CHARGE_FEE = '00000000-0000-0000-0000-00000000e003'
const CHARGE_UNPAYABLE = '00000000-0000-0000-0000-00000000e004'
const CHARGE_WEBHOOK = '00000000-0000-0000-0000-00000000e005'

let psql = () => { throw new Error('database not started') }
let stopDb = () => {}

function seedFixture() {
  psql(`
    insert into auth.users (id, email) values
      ('${ADMIN}', 'admin@example.com'), ('${PM}', 'pm@example.com'),
      ('${TENANT}', 'tenant@example.com'), ('${NEIGHBOUR}', 'neighbour@example.com'),
      ('${ADMIN_B}', 'other@example.com'), ('${DISABLED}', 'gone@example.com');

    insert into organizations (id, name, stripe_connect_account_id) values
      ('${ORG}', 'Test Org', 'acct_landlord'),
      ('${ORG_B}', 'Other Org', null),
      ('${ORG_UNPAYABLE}', 'Not Connected Org', null);

    insert into org_members (organization_id, user_id, role, status) values
      ('${ORG}', '${ADMIN}', 'admin', 'active'),
      ('${ORG}', '${PM}', 'property_manager', 'active'),
      ('${ORG}', '${NEIGHBOUR}', 'tenant', 'active'),
      ('${ORG_B}', '${ADMIN_B}', 'admin', 'active'),
      ('${ORG_UNPAYABLE}', '${TENANT}', 'tenant', 'active');
    insert into org_members (id, organization_id, user_id, role, status) values
      ('${TENANT_MEMBER}', '${ORG}', '${TENANT}', 'tenant', 'active');
    insert into org_members (organization_id, user_id, role, status) values
      ('${ORG}', '${DISABLED}', 'tenant', 'disabled');

    insert into properties (id, organization_id, name, address_line1, city, state, zip) values
      ('${ORG}', '${ORG}', 'Central', '1 St', 'Covington', 'KY', '41051'),
      ('${ORG_UNPAYABLE}', '${ORG_UNPAYABLE}', 'Elsewhere', '2 St', 'Newport', 'KY', '41071');
    insert into units (id, property_id, label) values
      ('${ORG}', '${ORG}', 'A'),
      ('${LEASE_TENANT_PAYS}', '${ORG}', 'B'),
      ('${ORG_UNPAYABLE}', '${ORG_UNPAYABLE}', 'A');

    insert into leases (id, unit_id, start_date, rent_amount, rent_due_day, status, fee_payer) values
      ('${LEASE}', '${ORG}', '2026-01-01', 1200, 1, 'active', 'landlord'),
      ('${LEASE_TENANT_PAYS}', '${LEASE_TENANT_PAYS}', '2026-01-01', 1200, 1, 'active', 'tenant'),
      ('${LEASE_UNPAYABLE}', '${ORG_UNPAYABLE}', '2026-01-01', 900, 1, 'active', 'landlord');

    insert into lease_tenants (lease_id, org_member_id, is_primary) values
      ('${LEASE}', '${TENANT_MEMBER}', true),
      ('${LEASE_TENANT_PAYS}', '${TENANT_MEMBER}', true),
      ('${LEASE_UNPAYABLE}',
       (select id from org_members where organization_id = '${ORG_UNPAYABLE}'), true),
      ('${LEASE}',
       (select id from org_members where user_id = '${DISABLED}'), false);

    insert into rent_charges (id, lease_id, charge_type, due_date, amount) values
      ('${CHARGE}', '${LEASE}', 'rent', '2026-02-01', 1200),
      ('${CHARGE_PAID}', '${LEASE}', 'rent', '2026-03-01', 1200),
      ('${CHARGE_FEE}', '${LEASE_TENANT_PAYS}', 'rent', '2026-02-01', 1200),
      ('${CHARGE_UNPAYABLE}', '${LEASE_UNPAYABLE}', 'rent', '2026-02-01', 900),
      ('${CHARGE_WEBHOOK}', '${LEASE}', 'rent', '2026-04-01', 1200);

    -- record_manual_payment checks the caller's role through auth.uid().
    select set_config('request.jwt.uid', '${ADMIN}', false);
    select record_manual_payment('${CHARGE_PAID}', 1200, 'check', current_date, 'paid');
  `)
}

const sql = (text) => psql(text).trim()

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${ok ? green('pass') : red('FAIL')}  ${label}`)
  if (!ok) {
    failures++
    console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

/** A Supabase-style access token, signed with the server's secret unless told otherwise. */
function token(sub, { secret = JWT_SECRET, ...opts } = {}) {
  return jwt.sign({ sub, role: 'authenticated' }, secret, { algorithm: 'HS256', expiresIn: '1h', ...opts })
}

async function main() {
  const db = startTestDb({ container: CONTAINER, port: PORT })
  psql = db.psql
  stopDb = db.stop
  seedFixture()

  // Before anything that reads config is imported.
  process.env.API_DATABASE_URL = db.url
  process.env.APP_URL = 'https://app.example.com'
  process.env.JWT_SECRET = JWT_SECRET
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
  process.env.ACH_FEE_PERCENT = '0.008'
  process.env.ACH_FEE_CAP_CENTS = '500'

  const { app } = await import('../app.mjs')
  const { stripe } = await import('../stripe.mjs')
  const { close } = await import('../db.mjs')

  // Stripe stand-ins. Each records its calls so the tests can check what
  // the server asked Stripe to do, not only what it answered.
  const calls = { intents: [], accounts: [], links: [], retrieves: [] }
  stripe.paymentIntents.create = async (params, opts) => {
    calls.intents.push({ params, opts })
    return { id: `pi_${calls.intents.length}`, client_secret: `secret_${calls.intents.length}` }
  }
  stripe.accounts.create = async (params) => {
    calls.accounts.push(params)
    return {
      id: 'acct_new', charges_enabled: false, payouts_enabled: false,
      requirements: { currently_due: ['external_account'] },
    }
  }
  stripe.accountLinks.create = async (params) => {
    calls.links.push(params)
    return { url: `https://connect.stripe.test/${params.account}` }
  }
  let retrieveError = null
  stripe.accounts.retrieve = async (id) => {
    calls.retrieves.push(id)
    if (retrieveError) throw retrieveError
    return {
      id, charges_enabled: true, payouts_enabled: true,
      requirements: { currently_due: [], pending_verification: ['ssn_last_4'] },
    }
  }

  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  // Quiet the server's own logging; the pass/fail lines are what matter.
  const log = console.log
  const error = console.error
  const quiet = (fn) => async (...args) => {
    console.log = () => {}
    console.error = () => {}
    try { return await fn(...args) } finally { console.log = log; console.error = error }
  }

  const call = quiet(async (method, path, { user, auth, body, headers = {} } = {}) => {
    const h = { ...headers }
    if (user) h.authorization = `Bearer ${token(user)}`
    if (auth) h.authorization = auth
    if (body !== undefined) h['content-type'] = 'application/json'
    const init = { method, headers: h }
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await fetch(base + path, init)
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json, text }
  })

  const webhook = quiet(async (event, { secret = WEBHOOK_SECRET, signature, tamper } = {}) => {
    const payload = JSON.stringify(event)
    const header = signature ?? stripe.webhooks.generateTestHeaderString({ payload, secret })
    const res = await fetch(`${base}/api/stripe/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(header ? { 'stripe-signature': header } : {}),
      },
      body: tamper ? tamper(payload) : payload,
    })
    return { status: res.status, text: await res.text() }
  })

  try {
    // ------------------------------------------------------------ who --

    console.log('\nwho is calling')
    let r = await call('POST', '/api/payments/intent', { body: { chargeId: CHARGE } })
    check('no session is refused', r.status, 401)

    r = await call('POST', '/api/payments/intent', {
      auth: `Bearer ${token(TENANT, { secret: 'not-the-secret' })}`, body: { chargeId: CHARGE },
    })
    check('a token signed with the wrong secret is refused', r.status, 401)

    r = await call('POST', '/api/payments/intent', {
      auth: `Bearer ${token(TENANT, { expiresIn: -60 })}`, body: { chargeId: CHARGE },
    })
    check('an expired token is refused', r.status, 401)
    check('without saying why to the caller', r.json?.error, 'Your session has expired — sign in again')

    // The classic JWT forgery: claim no signature is needed.
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: TENANT, role: 'authenticated' })}.`
    r = await call('POST', '/api/payments/intent', { auth: `Bearer ${unsigned}`, body: { chargeId: CHARGE } })
    check('an unsigned "alg: none" token is refused', r.status, 401)

    r = await call('POST', '/api/payments/intent', {
      auth: `Bearer ${jwt.sign({ role: 'authenticated' }, JWT_SECRET)}`, body: { chargeId: CHARGE },
    })
    check('a token naming nobody is refused', r.status, 401)

    // ---------------------------------------------------- paying rent --

    console.log('\nstarting a rent payment')
    r = await call('POST', '/api/payments/intent', { user: TENANT, body: {} })
    check('a request without a charge is a bad request', r.status, 400)

    r = await call('POST', '/api/payments/intent', { user: TENANT, body: { chargeId: CHARGE } })
    check('the tenant on the lease can pay', r.status, 200)
    check('and is told exactly what they will be debited', r.json?.breakdown,
      { rentCents: 120000, feeCents: 0, totalCents: 120000, feePaidByTenant: false })
    const asked = calls.intents.at(-1)
    check('Stripe is asked for the outstanding amount, from the ledger', asked?.params.amount, 120000)
    check("as a direct charge on the landlord's own account",
      asked?.opts, { stripeAccount: 'acct_landlord' })
    check('carrying the metadata the webhook reconciles against', asked?.params.metadata, {
      rent_charge_id: CHARGE, lease_id: LEASE, tenant_member_id: TENANT_MEMBER,
      rent_amount_cents: '120000', processing_fee_cents: '0',
    })

    // The body cannot set the amount. Anything other than chargeId is ignored.
    r = await call('POST', '/api/payments/intent', {
      user: TENANT, body: { chargeId: CHARGE_FEE, amount: 1, feeCents: 0 },
    })
    check('a lease where the tenant pays the fee adds it, capped at $5', r.json?.breakdown,
      { rentCents: 120000, feeCents: 500, totalCents: 120500, feePaidByTenant: true })
    check('whatever amount the browser sent', calls.intents.at(-1)?.params.amount, 120500)

    const before = calls.intents.length
    r = await call('POST', '/api/payments/intent', { user: NEIGHBOUR, body: { chargeId: CHARGE } })
    check("another tenant in the same organization cannot pay someone else's rent", r.status, 404)
    r = await call('POST', '/api/payments/intent', { user: ADMIN, body: { chargeId: CHARGE } })
    check('nor can the landlord, who is not on the lease', r.status, 404)
    r = await call('POST', '/api/payments/intent', { user: ADMIN_B, body: { chargeId: CHARGE } })
    check('nor another organization', r.status, 404)
    r = await call('POST', '/api/payments/intent', { user: DISABLED, body: { chargeId: CHARGE } })
    check('nor a tenant whose access was removed', r.status, 404)
    r = await call('POST', '/api/payments/intent', {
      user: TENANT, body: { chargeId: '00000000-0000-0000-0000-0000000000ff' },
    })
    check('a charge that does not exist looks the same as one that is not yours', r.status, 404)
    check('and none of those reached Stripe', calls.intents.length, before)

    r = await call('POST', '/api/payments/intent', { user: TENANT, body: { chargeId: CHARGE_PAID } })
    check('a charge already paid cannot be paid again', r.status, 409)

    r = await call('POST', '/api/payments/intent', { user: TENANT, body: { chargeId: CHARGE_UNPAYABLE } })
    check('a landlord who has not connected Stripe cannot be paid yet', r.status, 409)

    // An ACH debit in flight leaves the charge looking unpaid for days.
    psql(`
      insert into payments (lease_id, tenant_member_id, rent_charge_id, amount,
                            processing_fee_amount, total_charged, method, status,
                            stripe_payment_intent_id)
      values ('${LEASE}', '${TENANT_MEMBER}', '${CHARGE}', 1200, 0, 1200, 'ach',
              'processing', 'pi_in_flight');
    `)
    r = await call('POST', '/api/payments/intent', { user: TENANT, body: { chargeId: CHARGE } })
    check('a second payment while one is in flight is refused', r.status, 409)

    // ------------------------------------------------------- webhook --

    console.log('\nStripe telling us what happened')
    const metadata = {
      rent_charge_id: CHARGE_WEBHOOK, lease_id: LEASE, tenant_member_id: TENANT_MEMBER,
      rent_amount_cents: '120000', processing_fee_cents: '0',
    }
    const succeeded = {
      id: 'evt_1', type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_hook', amount: 120000, latest_charge: 'ch_hook', metadata } },
    }
    const paid = () => sql(`select amount_paid from rent_charges where id = '${CHARGE_WEBHOOK}'`)
    const payments = () => sql(`select count(*) from payments where stripe_payment_intent_id = 'pi_hook'`)

    let w = await webhook(succeeded, { signature: '' })
    check('a webhook with no signature is refused', w.status, 400)
    w = await webhook(succeeded, { secret: 'whsec_somebody_else' })
    check('a webhook signed with another secret is refused', w.status, 400)
    w = await webhook(succeeded, {
      tamper: (p) => p.replace('"amount":120000', '"amount":1'),
    })
    check('a correctly signed webhook whose body was altered is refused', w.status, 400)
    check('and none of them wrote a payment', payments(), '0')
    check('or credited any rent', paid(), '0.00')

    w = await webhook(succeeded)
    check('a genuine success is accepted', w.status, 200)
    check('and credits the rent', paid(), '1200.00')

    w = await webhook(succeeded)
    check('a redelivered success is accepted', w.status, 200)
    check('but credits nothing further', paid(), '1200.00')

    w = await webhook({
      id: 'evt_refund_part', type: 'charge.refunded',
      data: { object: { payment_intent: 'pi_hook', amount: 120000, amount_refunded: 5000, refunded: false } },
    })
    check('a partial refund is accepted', w.status, 200)
    check('and takes only the refund off the rent, not the whole payment', paid(), '1150.00')

    w = await webhook({
      id: 'evt_2', type: 'charge.dispute.created',
      data: { object: { payment_intent: 'pi_hook', reason: 'insufficient_funds' } },
    })
    check('the bank pulling the money back is accepted', w.status, 200)
    check('and the rent is owed again', paid(), '0.00')
    check('with the reason kept',
      sql(`select failure_reason from payments where stripe_payment_intent_id = 'pi_hook'`),
      'disputed: insufficient_funds')

    w = await webhook({
      id: 'evt_3', type: 'payment_intent.payment_failed',
      data: { object: {
        id: 'pi_failed', amount: 120000, metadata,
        last_payment_error: { message: 'Account closed' },
      } },
    })
    check('a failed payment is recorded', w.status, 200)
    check('with what the bank said',
      sql(`select status || ': ' || failure_reason from payments where stripe_payment_intent_id = 'pi_failed'`),
      'failed: Account closed')

    w = await webhook({
      id: 'evt_4', type: 'account.updated',
      data: { object: {
        id: 'acct_landlord', charges_enabled: true, payouts_enabled: true,
        requirements: { currently_due: [] },
      } },
    })
    check('a landlord finishing onboarding is accepted', w.status, 200)
    check('and the organization is marked payable',
      sql(`select stripe_charges_enabled from organizations where id = '${ORG}'`), 't')

    w = await webhook({ id: 'evt_5', type: 'customer.created', data: { object: {} } })
    check('an event nobody handles is acknowledged, not retried forever', w.status, 200)

    // A handler failure must be a 500 so Stripe retries rather than the
    // event being lost.
    w = await webhook({
      id: 'evt_6', type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_bad', amount: 1, metadata } },
    })
    check('a payment that does not reconcile is a server error, so Stripe retries', w.status, 500)
    check('and nothing is written for it',
      sql(`select count(*) from payments where stripe_payment_intent_id = 'pi_bad'`), '0')

    // ------------------------------------------------------- connect --

    console.log('\nconnecting a landlord to Stripe')
    r = await call('POST', '/api/connect/onboarding-link', { user: ADMIN_B, body: {} })
    check('a request without an organization is a bad request', r.status, 400)

    for (const [who, label] of [
      [PM, 'a property manager'], [TENANT, 'a tenant'], [ADMIN_B, "another organization's admin"],
    ]) {
      r = await call('POST', '/api/connect/onboarding-link', { user: who, body: { organizationId: ORG } })
      check(`${label} cannot start onboarding`, r.status, 403)
    }
    check('and none of them created a Stripe account', calls.accounts.length, 0)

    r = await call('POST', '/api/connect/onboarding-link', { user: ADMIN_B, body: { organizationId: ORG_B } })
    check('an admin can start onboarding their own organization', r.status, 200)
    check('and is sent to Stripe for it', r.json?.url, 'https://connect.stripe.test/acct_new')
    check('one account is created', calls.accounts.length, 1)
    check('tagged with the organization it belongs to',
      calls.accounts[0]?.metadata, { organization_id: ORG_B })
    check('and remembered before the landlord is sent away',
      sql(`select stripe_connect_account_id from organizations where id = '${ORG_B}'`), 'acct_new')
    check('coming back to the app, not somewhere else', calls.links[0]?.return_url,
      'https://app.example.com/dashboard?stripe=return')

    r = await call('POST', '/api/connect/onboarding-link', { user: ADMIN_B, body: { organizationId: ORG_B } })
    check('starting again resumes the same account', r.json?.url, 'https://connect.stripe.test/acct_new')
    check('rather than creating a second one', calls.accounts.length, 1)

    r = await call('GET', `/api/connect/status?organizationId=${ORG}`, { user: PM })
    check('a property manager can see whether the landlord can be paid', r.status, 200)
    check('read live from Stripe', r.json,
      { connected: true, chargesEnabled: true, payoutsEnabled: true, requirementsDue: [], pendingVerification: true })
    r = await call('GET', `/api/connect/status?organizationId=${ORG}`, { user: TENANT })
    check('a tenant cannot', r.status, 403)
    r = await call('GET', `/api/connect/status?organizationId=${ORG}`, { user: ADMIN_B })
    check('nor another organization', r.status, 403)
    r = await call('GET', `/api/connect/status?organizationId=${ORG_UNPAYABLE}`, { user: TENANT })
    check('and being a tenant somewhere does not count', r.status, 403)

    // ------------------------------------------------------- errors --

    console.log('\nwhen something breaks')
    retrieveError = new Error('relation "organizations_secret_column" does not exist')
    r = await call('GET', `/api/connect/status?organizationId=${ORG}`, { user: ADMIN })
    check('an unexpected failure is a 500', r.status, 500)
    check('that tells the browser nothing about the internals',
      r.json, { error: 'Something went wrong on our end.' })
    retrieveError = null

    r = await call('GET', '/api/health')
    check('the health check answers, in test mode', r.json, { ok: true, mode: 'test' })
  } finally {
    server.close()
    await close()
  }

  console.log(failures === 0 ? green('\nAll API tests passed.') : red(`\n${failures} check(s) failed.`))
  return failures === 0 ? 0 : 1
}

let code = 1
try {
  code = await main()
} catch (err) {
  console.error(red(`\n${err.stack || err.message}`))
} finally {
  stopDb()
}
process.exit(code)

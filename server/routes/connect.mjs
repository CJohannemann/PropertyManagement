// Connecting a landlord's Stripe account, so rent has somewhere to land.
//
// The landlord never types bank or tax details into this app. We create an
// account shell, hand back a Stripe-hosted onboarding URL, and Stripe
// collects everything sensitive itself. What comes back to us is an
// account id and some booleans.

import express from 'express'
import { stripe, CONNECT_CONTROLLER } from '../stripe.mjs'
import { config } from '../config.mjs'
import { query } from '../db.mjs'
import { requireUser, requireOrgRole, HttpError } from '../auth.mjs'

export const connectRouter = express.Router()

// Requested for every connected account:
//
//   card_payments + transfers — the base pair that makes a connected
//     account the merchant of record on direct charges. Stripe requires
//     transfers alongside card_payments. We do not offer card payments in
//     the UI; this is about being able to take a payment at all.
//   us_bank_account_ach_payments — ACH Direct Debit itself, which is a
//     payment-method capability in its own right.
//
// The KYC Stripe collects is the same for all three, so this costs the
// landlord no extra onboarding.
const CAPABILITIES = {
  card_payments: { requested: true },
  transfers: { requested: true },
  us_bank_account_ach_payments: { requested: true },
}

async function loadOrg(orgId) {
  const { rows } = await query(
    'select id, name, stripe_connect_account_id from organizations where id = $1',
    [orgId],
  )
  if (!rows[0]) throw new HttpError(404, 'No such organization')
  return rows[0]
}

/** Writes back what Stripe says about an account, so the UI can read it cheaply. */
async function cacheAccountState(orgId, account) {
  await query(
    `update organizations
        set stripe_charges_enabled = $2,
            stripe_payouts_enabled = $3,
            stripe_requirements_due = $4
      where id = $1`,
    [
      orgId,
      account.charges_enabled,
      account.payouts_enabled,
      account.requirements?.currently_due ?? [],
    ],
  )
}

/**
 * Starts or resumes onboarding. Returns a one-use Stripe URL to redirect
 * the landlord to.
 *
 * Safe to call repeatedly: an account is created only if the org has none,
 * and account links expire after a few minutes by design, so "click the
 * button again" is the intended recovery from an abandoned session.
 */
connectRouter.post('/onboarding-link', requireUser, async (req, res) => {
  const { organizationId } = req.body ?? {}
  if (!organizationId) throw new HttpError(400, 'organizationId is required')

  // Only an admin. Checked against the database, not against anything the
  // caller told us.
  await requireOrgRole(req.userId, organizationId, ['admin'])

  const org = await loadOrg(organizationId)
  let accountId = org.stripe_connect_account_id

  if (!accountId) {
    const { rows } = await query('select email from auth.users where id = $1', [req.userId])
    const account = await stripe.accounts.create({
      controller: CONNECT_CONTROLLER,
      country: 'US',
      email: rows[0]?.email ?? undefined,
      capabilities: CAPABILITIES,
      business_profile: {
        name: org.name,
        // Rent collection. Stripe asks for this and a landlord rarely has
        // a website to point at.
        product_description: 'Residential rent collection',
      },
      metadata: { organization_id: org.id },
    })
    accountId = account.id

    // Stored before the redirect, not after: if this write fails we must
    // not send the landlord into an onboarding flow for an account we
    // have forgotten the id of, which would strand a real Stripe account
    // with their identity documents attached to it.
    await query(
      'update organizations set stripe_connect_account_id = $2 where id = $1',
      [org.id, accountId],
    )
    await cacheAccountState(org.id, account)
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    // Both required by Stripe. refresh_url is where an expired or reused
    // link lands, and simply sends them back through this endpoint.
    refresh_url: `${config.appUrl}/dashboard?stripe=refresh`,
    return_url: `${config.appUrl}/dashboard?stripe=return`,
  })

  res.json({ url: link.url })
})

/**
 * Whether this organization can actually be paid yet.
 *
 * Read live from Stripe rather than from our cached columns: this is the
 * screen a landlord stares at while waiting for verification to clear, and
 * a stale "not enabled" would have them redoing onboarding they already
 * finished.
 */
connectRouter.get('/status', requireUser, async (req, res) => {
  const organizationId = req.query.organizationId
  if (!organizationId) throw new HttpError(400, 'organizationId is required')

  await requireOrgRole(req.userId, organizationId, ['admin', 'property_manager'])

  const org = await loadOrg(organizationId)
  if (!org.stripe_connect_account_id) {
    return res.json({ connected: false, chargesEnabled: false, payoutsEnabled: false, requirementsDue: [] })
  }

  const account = await stripe.accounts.retrieve(org.stripe_connect_account_id)
  await cacheAccountState(org.id, account)

  res.json({
    connected: true,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    requirementsDue: account.requirements?.currently_due ?? [],
    // Stripe is still checking something it has already been given.
    pendingVerification: (account.requirements?.pending_verification ?? []).length > 0,
  })
})

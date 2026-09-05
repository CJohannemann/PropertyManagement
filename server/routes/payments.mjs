// Starting a rent payment.
//
// The request body carries a charge id and nothing else that matters. Every
// figure — what is owed, what the fee is, what the tenant is debited — is
// derived here from the ledger. A browser that asks to pay $1 towards a
// $1,200 charge is asking about a charge id it does not control the amount
// of.

import express from 'express'
import { stripe, achFeeCents } from '../stripe.mjs'
import { query } from '../db.mjs'
import { requireUser, HttpError } from '../auth.mjs'

export const paymentsRouter = express.Router()

/**
 * numeric(10,2) arrives from pg as a string ("1200.00") deliberately —
 * parsing money through a float is how a ledger ends up a cent out. Round
 * once, at the boundary, into integer cents and stay there.
 */
function toCents(numericString) {
  return Math.round(Number(numericString) * 100)
}

/**
 * node-postgres parses a DATE column into a Date, but this only feeds a
 * human-readable description on the Stripe charge — not worth throwing a
 * payment away over if that ever changes.
 */
function isoDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value ?? '').slice(0, 10)
}

paymentsRouter.post('/intent', requireUser, async (req, res) => {
  const { chargeId } = req.body ?? {}
  if (!chargeId) throw new HttpError(400, 'chargeId is required')

  // One query establishes both what is owed and that this caller is
  // entitled to pay it. The join through lease_tenants is the
  // authorisation: a charge on someone else's lease returns no row, which
  // is indistinguishable to the caller from a charge that does not exist.
  const { rows } = await query(
    `select rc.id, rc.amount, rc.amount_paid, rc.charge_type, rc.due_date,
            l.id as lease_id, l.fee_payer,
            om.id as tenant_member_id,
            o.id as organization_id,
            o.stripe_connect_account_id,
            u.label as unit_label, p.name as property_name
       from rent_charges rc
       join leases l on l.id = rc.lease_id
       join units u on u.id = l.unit_id
       join properties p on p.id = u.property_id
       join organizations o on o.id = p.organization_id
       join lease_tenants lt on lt.lease_id = l.id
       join org_members om on om.id = lt.org_member_id
      where rc.id = $1 and om.user_id = $2 and om.status = 'active'`,
    [chargeId, req.userId],
  )
  const charge = rows[0]
  if (!charge) throw new HttpError(404, 'No such charge')

  if (!charge.stripe_connect_account_id) {
    throw new HttpError(
      409,
      'Your landlord has not finished setting up online payments yet.',
    )
  }

  const outstandingCents = toCents(charge.amount) - toCents(charge.amount_paid)
  if (outstandingCents <= 0) throw new HttpError(409, 'That charge is already paid')

  // The real protection against paying rent twice. ACH sits in
  // 'processing' for days, during which the charge still looks unpaid — so
  // without this a tenant who comes back on day three, sees "unpaid", and
  // pays again would be debited twice for one month's rent.
  const inFlight = await query(
    `select id from payments
      where rent_charge_id = $1 and status in ('pending', 'processing')`,
    [chargeId],
  )
  if (inFlight.rows.length > 0) {
    throw new HttpError(
      409,
      'A payment for this charge is already on its way to your landlord. '
      + 'Bank transfers take a few business days to clear.',
    )
  }

  // Who absorbs Stripe's cut. fee_payer is per-lease and already refused
  // by the database in states where passing it to a tenant is not verified
  // as legal — see the guard in db/migrations/005_late_fee_accrual.sql.
  const feeCents = charge.fee_payer === 'tenant' ? achFeeCents(outstandingCents) : 0
  const totalCents = outstandingCents + feeCents

  const intent = await stripe.paymentIntents.create(
    {
      amount: totalCents,
      currency: 'usd',
      payment_method_types: ['us_bank_account'],
      description: `${charge.charge_type} due ${isoDate(charge.due_date)}`
        + ` — ${charge.property_name}${charge.unit_label ? ` ${charge.unit_label}` : ''}`,
      // Read back by the webhook, which is the only thing that writes to
      // `payments`. Stripe metadata values must be strings.
      metadata: {
        rent_charge_id: charge.id,
        lease_id: charge.lease_id,
        tenant_member_id: charge.tenant_member_id,
        rent_amount_cents: String(outstandingCents),
        processing_fee_cents: String(feeCents),
      },
    },
    // A direct charge on the landlord's own account: they are the merchant
    // of record for their own rent, and the money settles to them rather
    // than passing through a platform balance.
    { stripeAccount: charge.stripe_connect_account_id },
  )

  res.json({
    clientSecret: intent.client_secret,
    // The connected account the Element must be initialised against —
    // a direct charge's client secret is only valid in that context.
    stripeAccount: charge.stripe_connect_account_id,
    // Itemised so the tenant sees rent and fee separately before
    // confirming, rather than one unexplained total.
    breakdown: {
      rentCents: outstandingCents,
      feeCents,
      totalCents,
      feePaidByTenant: charge.fee_payer === 'tenant',
    },
  })
})

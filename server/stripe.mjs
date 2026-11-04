// The Stripe client, plus the account configuration this platform creates
// connected accounts with.

import Stripe from 'stripe'
import { config } from './config.mjs'

export const stripe = new Stripe(config.stripe.secretKey)

/**
 * How a landlord's connected account is configured.
 *
 * Written as controller properties rather than `type: 'standard'`: Stripe
 * now treats the account types as legacy and tells new platforms not to
 * use them. These values are the Standard preset — Stripe-hosted
 * onboarding, and the landlord gets the full Stripe Dashboard for their
 * own account.
 *
 * Not the Express dashboard, which an earlier version asked for. Stripe
 * refuses Express unless the platform collects the fees and is liable for
 * negative balances ("When stripe_dashboard[type]=express, your platform
 * must collect fees and be liable…"), and both of those are what this
 * deliberately avoids:
 *
 *   losses.payments: 'stripe' — a tenant can dispute an ACH debit for up
 *     to 60 days after it settled; if the landlord has already been paid
 *     out and spent it, that shortfall lands on Stripe and the landlord,
 *     not on this platform.
 *
 *   fees.payer: 'account' — the landlord pays Stripe's processing fees out
 *     of their own balance, so this platform never fronts money it then
 *     has to bill back.
 *
 * Both fit what rent is here: a direct charge, with the landlord as the
 * merchant of record for their own rent.
 */
export const CONNECT_CONTROLLER = {
  stripe_dashboard: { type: 'full' },
  losses: { payments: 'stripe' },
  fees: { payer: 'account' },
  requirement_collection: 'stripe',
}

/**
 * What this platform charges a tenant on top of the rent when the lease
 * says the tenant absorbs the processing fee.
 *
 * Everything is integer cents. Rent is money and money in floating point
 * accumulates error — $1200.10 is not representable, and a ledger that is
 * a cent out every month is a ledger nobody trusts.
 */
export function achFeeCents(amountCents) {
  const fee = Math.round(amountCents * config.achFee.percent)
  return Math.min(fee, config.achFee.capCents)
}

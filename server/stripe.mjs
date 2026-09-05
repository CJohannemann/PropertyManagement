// The Stripe client, plus the account configuration this platform creates
// connected accounts with.

import Stripe from 'stripe'
import { config } from './config.mjs'

export const stripe = new Stripe(config.stripe.secretKey)

/**
 * How a landlord's connected account is configured.
 *
 * Written as controller properties rather than `type: 'express'`: Stripe
 * now treats the account types as legacy and tells new platforms not to
 * use them. These values reproduce Express behaviour — Stripe-hosted
 * onboarding, Express dashboard — with one deliberate difference:
 *
 *   losses.payments: 'stripe'
 *
 * The Express preset sets that to 'application', which makes THIS platform
 * liable for a landlord's negative balance. A tenant can dispute an ACH
 * debit for up to 60 days after it settled; if the landlord has already
 * been paid out and spent it, that shortfall would land on us. Stripe
 * carries it instead.
 *
 * fees.payer: 'account' — the landlord pays Stripe's processing fees out
 * of their own balance, so this platform never fronts money it then has to
 * bill back.
 */
export const CONNECT_CONTROLLER = {
  stripe_dashboard: { type: 'express' },
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

// Writing what Stripe tells us into the rent ledger.
//
// Separated from the webhook route so these can be exercised directly by
// server/test/ledger.test.mjs against a real database — the ordering and
// idempotency rules below are the part of this system where a mistake
// costs someone real money, and testing them through HTTP and a signature
// check would test less of them, not more.
//
// Three properties to hold:
//
//   1. Idempotency. Stripe retries for days. The unique constraint on
//      stripe_payment_intent_id plus an upsert makes a replay a no-op
//      rather than a second credit.
//   2. Order-independence. Stripe does not promise events arrive in the
//      order they happened, so a late 'processing' must not un-succeed a
//      payment that has already settled.
//   3. Reconciliation. The rent/fee split recorded must add up to what the
//      tenant was actually debited, or nothing is recorded at all.

import { query } from './db.mjs'

const centsToNumeric = (cents) => (cents / 100).toFixed(2)

export async function upsertPayment(intent, status, extra = {}) {
  const meta = intent.metadata ?? {}
  if (!meta.rent_charge_id || !meta.lease_id || !meta.tenant_member_id) {
    // Not a payment this app created — someone charging through the
    // landlord's Stripe account directly, for instance. Not ours to record.
    console.log(`[ledger] ${intent.id}: no app metadata, ignoring`)
    return { recorded: false }
  }

  const rentCents = Number(meta.rent_amount_cents)
  const feeCents = Number(meta.processing_fee_cents ?? 0)

  // If the split does not add up, something has rewritten one side of it.
  // The safe move is to record nothing and shout, not to guess which half
  // is right and write a ledger row that is quietly wrong.
  if (!Number.isFinite(rentCents) || rentCents + feeCents !== intent.amount) {
    throw new Error(
      `payment ${intent.id} does not reconcile: metadata split `
      + `(${rentCents} + ${feeCents}) vs charged ${intent.amount}`,
    )
  }

  await query(
    `insert into payments
       (lease_id, tenant_member_id, rent_charge_id, amount, processing_fee_amount,
        total_charged, method, status, stripe_payment_intent_id,
        stripe_charge_id, failure_reason, paid_at)
     values ($1, $2, $3, $4, $5, $6, 'ach', $7, $8, $9, $10, $11)
     on conflict (stripe_payment_intent_id) do update set
       status = case
         -- Terminal and already reversed: nothing moves it.
         when payments.status = 'refunded' then payments.status
         -- Settled or failed: only a reversal may follow, never a
         -- re-delivered earlier event.
         when payments.status in ('succeeded', 'failed')
              and excluded.status in ('pending', 'processing') then payments.status
         else excluded.status
       end,
       stripe_charge_id = coalesce(excluded.stripe_charge_id, payments.stripe_charge_id),
       failure_reason = coalesce(excluded.failure_reason, payments.failure_reason),
       paid_at = coalesce(payments.paid_at, excluded.paid_at)`,
    [
      meta.lease_id,
      meta.tenant_member_id,
      meta.rent_charge_id,
      centsToNumeric(rentCents),
      centsToNumeric(feeCents),
      centsToNumeric(intent.amount),
      status,
      intent.id,
      extra.chargeId ?? null,
      extra.failureReason ?? null,
      status === 'succeeded' ? new Date() : null,
    ],
  )
  console.log(`[ledger] ${intent.id} -> ${status}`)
  return { recorded: true }
}

/** Reverses a payment that has already been credited. */
export async function reversePayment(paymentIntentId, reason) {
  const { rowCount } = await query(
    `update payments
        set status = 'refunded', failure_reason = coalesce(failure_reason, $2)
      where stripe_payment_intent_id = $1 and status <> 'refunded'`,
    [paymentIntentId, reason],
  )
  console.log(
    rowCount > 0
      ? `[ledger] ${paymentIntentId} reversed (${reason})`
      : `[ledger] ${paymentIntentId} already reversed or unknown`,
  )
  return { reversed: rowCount > 0 }
}

/** Caches what Stripe says about a landlord's connected account. */
export async function updateConnectState(account) {
  await query(
    `update organizations
        set stripe_charges_enabled = $2,
            stripe_payouts_enabled = $3,
            stripe_requirements_due = $4
      where stripe_connect_account_id = $1`,
    [
      account.id,
      account.charges_enabled,
      account.payouts_enabled,
      account.requirements?.currently_due ?? [],
    ],
  )
}

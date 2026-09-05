// Stripe's webhook: the only thing in this system that writes to
// `payments`, and therefore the only thing that can say rent was paid.
//
// This file is HTTP concerns only — verify the signature, map an event to
// a ledger operation, decide the status code. The writes themselves are in
// ../ledger.mjs so they can be tested directly against a database.

import express from 'express'
import { stripe } from '../stripe.mjs'
import { config } from '../config.mjs'
import { upsertPayment, reversePayment, updateConnectState } from '../ledger.mjs'

export const webhookRouter = express.Router()

// express.raw, not express.json: constructEvent verifies a signature over
// the exact bytes Stripe sent, and any parse-then-restringify changes them.
webhookRouter.post(
  '/',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let event
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.get('stripe-signature'),
        config.stripe.webhookSecret,
      )
    } catch (err) {
      // 400, not 500: an unsigned or missigned request is not worth
      // Stripe retrying, and this is exactly the forgery that the missing
      // client-side insert policy on `payments` exists to prevent.
      console.error('[webhook] signature verification failed:', err.message)
      return res.status(400).send('invalid signature')
    }

    try {
      switch (event.type) {
        case 'payment_intent.processing':
          await upsertPayment(event.data.object, 'processing')
          break

        case 'payment_intent.succeeded':
          await upsertPayment(event.data.object, 'succeeded', {
            chargeId: event.data.object.latest_charge ?? null,
          })
          break

        case 'payment_intent.payment_failed':
          await upsertPayment(event.data.object, 'failed', {
            failureReason:
              event.data.object.last_payment_error?.message
              ?? event.data.object.last_payment_error?.code
              ?? 'The bank declined the payment',
          })
          break

        // The ACH reversal path, and the reason this is not just
        // charge.refunded. Stripe's docs: a bank failure arriving *after*
        // a PaymentIntent has succeeded is raised as a dispute, with a
        // reason like insufficient_funds or incorrect_account_details.
        // Handled here, the rent goes back to owed; unhandled, the app
        // would insist it had been paid.
        case 'charge.dispute.created':
          await reversePayment(
            event.data.object.payment_intent,
            `disputed: ${event.data.object.reason}`,
          )
          break

        case 'charge.refunded':
          await reversePayment(event.data.object.payment_intent, 'refunded')
          break

        // A landlord finished, or progressed through, onboarding.
        case 'account.updated':
          await updateConnectState(event.data.object)
          break

        default:
          // Everything else is fine to ignore, but say so — a payment
          // event nobody handles should be findable in the log.
          console.log(`[webhook] unhandled event ${event.type}`)
      }
    } catch (err) {
      // 500 so Stripe retries. Better a duplicate delivery against an
      // idempotent handler than a payment that silently never lands.
      console.error(`[webhook] handling ${event.type} failed:`, err.message)
      return res.status(500).send('handler failed')
    }

    res.json({ received: true })
  },
)

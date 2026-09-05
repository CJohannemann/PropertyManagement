import { loadStripe, type Stripe } from '@stripe/stripe-js'
import { apiFetch } from './api'

const PUBLISHABLE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? ''

export const stripeConfigured = PUBLISHABLE_KEY.startsWith('pk_')

export type ConnectStatus = {
  connected: boolean
  chargesEnabled: boolean
  payoutsEnabled: boolean
  requirementsDue: string[]
  pendingVerification?: boolean
}

export type PaymentBreakdown = {
  rentCents: number
  feeCents: number
  totalCents: number
  feePaidByTenant: boolean
}

export type PaymentIntentResponse = {
  clientSecret: string
  stripeAccount: string
  breakdown: PaymentBreakdown
}

export function fetchConnectStatus(organizationId: string): Promise<ConnectStatus> {
  return apiFetch<ConnectStatus>(
    `/connect/status?organizationId=${encodeURIComponent(organizationId)}`,
  )
}

/** Returns a one-use Stripe-hosted onboarding URL to redirect the landlord to. */
export function createOnboardingLink(organizationId: string): Promise<{ url: string }> {
  return apiFetch<{ url: string }>('/connect/onboarding-link', {
    method: 'POST',
    body: { organizationId },
  })
}

/**
 * Starts a rent payment. Sends only the charge id — the server works out
 * what is owed, so there is no amount here for a tampered client to change.
 */
export function createPaymentIntent(chargeId: string): Promise<PaymentIntentResponse> {
  return apiFetch<PaymentIntentResponse>('/payments/intent', {
    method: 'POST',
    body: { chargeId },
  })
}

/**
 * Stripe.js bound to the landlord's connected account.
 *
 * The account matters: rent is a direct charge on the landlord's own
 * Stripe account, and a client secret from that account is only valid in a
 * Stripe.js instance initialised against it. Cached per account so
 * switching between screens doesn't reload the script.
 */
const stripeByAccount = new Map<string, Promise<Stripe | null>>()

export function stripeFor(account: string): Promise<Stripe | null> {
  if (!stripeConfigured) {
    return Promise.reject(new Error('Stripe is not configured for this build'))
  }
  let promise = stripeByAccount.get(account)
  if (!promise) {
    promise = loadStripe(PUBLISHABLE_KEY, { stripeAccount: account })
    stripeByAccount.set(account, promise)
  }
  return promise
}

export function centsToMoney(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

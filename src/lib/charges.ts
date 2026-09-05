import { supabase } from './supabase'

export type ChargeType =
  | 'rent'
  | 'late_fee'
  | 'prorated_rent'
  | 'security_deposit'
  | 'pet_deposit'
  | 'other_deposit'
  | 'nonrefundable_fee'
  | 'nsf_fee'
  | 'other'

export type Charge = {
  id: string
  lease_id: string
  charge_type: ChargeType
  due_date: string
  amount: number
  amount_paid: number
  status: 'pending' | 'partial' | 'paid' | 'late'
}

const CHARGE_LABELS: Record<ChargeType, string> = {
  rent: 'Rent',
  late_fee: 'Late fee',
  prorated_rent: 'Prorated rent',
  security_deposit: 'Security deposit',
  pet_deposit: 'Pet deposit',
  other_deposit: 'Deposit',
  nonrefundable_fee: 'Non-refundable fee',
  nsf_fee: 'Returned payment fee',
  other: 'Other charge',
}

/** Falls back to the raw type so a charge type added in SQL but not here
 *  still shows something recognisable rather than blank. */
export function chargeLabel(t: ChargeType): string {
  return CHARGE_LABELS[t] ?? t
}

/** Money received against a charge. */
export type PaymentRow = {
  id: string
  amount: number
  method: 'ach' | 'card' | 'cash' | 'check' | 'bank_transfer' | 'other'
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'refunded'
  paid_at: string | null
  note: string | null
}

export const PAYMENT_METHODS = [
  { value: 'check', label: 'Cheque' },
  { value: 'cash', label: 'Cash' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'other', label: 'Something else' },
] as const

const METHOD_LABELS: Record<PaymentRow['method'], string> = {
  ach: 'bank transfer', card: 'card', cash: 'cash',
  check: 'cheque', bank_transfer: 'bank transfer', other: 'other',
}

export function methodLabel(m: PaymentRow['method']): string {
  return METHOD_LABELS[m] ?? m
}

/** A charge with enough context to say which unit of which property it belongs to. */
export type ChargeWithPlace = Charge & {
  payments?: PaymentRow[]
  leases: {
    id: string
    units: {
      id: string
      label: string
      properties: { id: string; name: string }
    } | null
  } | null
}

const CHARGE_COLUMNS =
  'id, lease_id, charge_type, due_date, amount, amount_paid, status'

/**
 * Every charge the caller can see. RLS does the scoping: an admin or
 * property manager gets the whole organization, a tenant gets only their
 * own lease's charges, so this one query serves both.
 */
export async function fetchCharges(): Promise<ChargeWithPlace[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('rent_charges')
    // ids as well as labels: the rent status screen groups by property and
    // unit, and two properties in one organization may legitimately share a
    // name (two "Main St" buildings), which would silently merge their
    // money into one row if the name were the key.
    //
    // payments embedded so "has this been paid, and how" is answerable
    // without a query per charge. RLS scopes them the same way it scopes
    // the charge itself.
    .select(
      `${CHARGE_COLUMNS}, leases(id, units(id, label, properties(id, name))),`
      + ' payments(id, amount, method, status, paid_at, note)',
    )
    .order('due_date', { ascending: false })
  if (error) throw error
  return data as unknown as ChargeWithPlace[]
}

// Defined in owed.ts, which is import-free so db/test/overdue.mjs can
// exercise it directly. Re-exported here because every caller already
// reaches for these through this module.
export { outstanding, totalOutstanding, isOverdue, statusLabel, groupByProperty } from './owed'

/**
 * Records rent that arrived outside the app — a cheque, cash, a bank
 * transfer someone sent directly.
 *
 * Goes through record_manual_payment() rather than inserting a row,
 * because `payments` is deliberately not client-writable: only the Stripe
 * webhook writes it, so a compromised browser cannot fake a settled
 * payment. The function checks in SQL that the caller really is an admin
 * or property manager of the organization that owns the charge.
 */
export async function recordManualPayment(input: {
  chargeId: string
  amount: number
  method: string
  paidOn: string
  note?: string | null
}): Promise<string> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.rpc('record_manual_payment', {
    charge: input.chargeId,
    amount: input.amount,
    method: input.method,
    paid_on: input.paidOn,
    note: input.note?.trim() || null,
  })
  if (error) throw error
  return data as string
}

/** Undoes a hand-recorded payment. Stripe payments must be refunded in Stripe. */
export async function voidManualPayment(paymentId: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.rpc('void_manual_payment', { payment: paymentId })
  if (error) throw error
}

export function money(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

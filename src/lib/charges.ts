import { supabase } from './supabase'

export type Charge = {
  id: string
  lease_id: string
  charge_type: 'rent' | 'late_fee' | 'other'
  due_date: string
  amount: number
  amount_paid: number
  status: 'pending' | 'partial' | 'paid' | 'late'
}

/** A charge with enough context to say which unit of which property it belongs to. */
export type ChargeWithPlace = Charge & {
  leases: {
    id: string
    units: { label: string; properties: { name: string } } | null
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
    .select(`${CHARGE_COLUMNS}, leases(id, units(label, properties(name)))`)
    .order('due_date', { ascending: false })
  if (error) throw error
  return data as unknown as ChargeWithPlace[]
}

export function outstanding(c: Charge): number {
  return Math.max(Number(c.amount) - Number(c.amount_paid), 0)
}

export function totalOutstanding(charges: Charge[]): number {
  return charges.reduce((sum, c) => sum + outstanding(c), 0)
}

/**
 * Whether a charge is actually overdue today. Deliberately derived from
 * the date rather than read off `status`: a partly-paid charge stays
 * 'partial' past its due date (that's more informative than overwriting it
 * with 'late'), so status alone would under-report what's overdue. See
 * mark_overdue_charges() in db/migrations/002_rent_billing.sql.
 */
export function isOverdue(c: Charge): boolean {
  return outstanding(c) > 0 && new Date(c.due_date) < new Date(new Date().toDateString())
}

export function money(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

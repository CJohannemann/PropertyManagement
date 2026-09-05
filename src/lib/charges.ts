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

/** A charge with enough context to say which unit of which property it belongs to. */
export type ChargeWithPlace = Charge & {
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
    .select(`${CHARGE_COLUMNS}, leases(id, units(id, label, properties(id, name)))`)
    .order('due_date', { ascending: false })
  if (error) throw error
  return data as unknown as ChargeWithPlace[]
}

// Defined in owed.ts, which is import-free so db/test/overdue.mjs can
// exercise it directly. Re-exported here because every caller already
// reaches for these through this module.
export { outstanding, totalOutstanding, isOverdue, statusLabel, groupByProperty } from './owed'

export function money(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

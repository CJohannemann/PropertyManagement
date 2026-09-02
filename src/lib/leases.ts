import { supabase } from './supabase'

export type Lease = {
  id: string
  unit_id: string
  start_date: string
  end_date: string | null
  rent_amount: number
  rent_due_day: number
  deposit_amount: number
  status: 'pending' | 'active' | 'ended'
  late_fee_auto_apply: boolean
  late_fee_type: 'flat' | 'percent' | null
  late_fee_amount: number | null
  late_fee_grace_days: number | null
  fee_payer: 'landlord' | 'tenant'
}

export type LeaseTenant = {
  id: string
  is_primary: boolean
  org_member_id: string
}

export async function fetchLeasesForUnit(unitId: string): Promise<Lease[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('leases')
    .select(
      'id, unit_id, start_date, end_date, rent_amount, rent_due_day, deposit_amount, status, late_fee_auto_apply, late_fee_type, late_fee_amount, late_fee_grace_days, fee_payer',
    )
    .eq('unit_id', unitId)
    .order('start_date', { ascending: false })
  if (error) throw error
  return data as Lease[]
}

export type NewLease = {
  unitId: string
  startDate: string
  endDate: string | null
  rentAmount: number
  rentDueDay: number
  depositAmount: number
  lateFeeAutoApply: boolean
  lateFeeType: 'flat' | 'percent' | null
  lateFeeAmount: number | null
  lateFeeGraceDays: number | null
  feePayer: 'landlord' | 'tenant'
}

/**
 * Inserts a lease. The late-fee and fee-payer fields are re-checked
 * server-side by db/schema.sql's enforce_late_fee_limits trigger against
 * the property's state — the form disables what it can up front, but the
 * database is what actually enforces it, so a rejection here is expected
 * and its message is worth surfacing verbatim.
 */
export async function createLease(input: NewLease): Promise<Lease> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase
    .from('leases')
    .insert({
      unit_id: input.unitId,
      start_date: input.startDate,
      end_date: input.endDate,
      rent_amount: input.rentAmount,
      rent_due_day: input.rentDueDay,
      deposit_amount: input.depositAmount,
      status: 'active',
      late_fee_auto_apply: input.lateFeeAutoApply,
      late_fee_type: input.lateFeeType,
      late_fee_amount: input.lateFeeAmount,
      late_fee_grace_days: input.lateFeeGraceDays,
      fee_payer: input.feePayer,
    })
    .select(
      'id, unit_id, start_date, end_date, rent_amount, rent_due_day, deposit_amount, status, late_fee_auto_apply, late_fee_type, late_fee_amount, late_fee_grace_days, fee_payer',
    )
    .single()
  if (error) throw error
  return data as Lease
}

/** Who's already on a lease — so the UI can say "invited" vs "nobody yet". */
export async function fetchLeaseTenants(leaseId: string): Promise<LeaseTenant[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('lease_tenants')
    .select('id, is_primary, org_member_id')
    .eq('lease_id', leaseId)
  if (error) throw error
  return data as LeaseTenant[]
}

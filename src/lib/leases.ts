import { supabase } from './supabase'

export type Lease = {
  id: string
  unit_id: string
  start_date: string
  end_date: string | null
  rent_amount: number
  rent_due_day: number
  /** The security deposit specifically — see the other *_deposit fields. */
  deposit_amount: number
  pet_deposit_amount: number | null
  other_deposit_amount: number | null
  other_deposit_label: string | null
  nonrefundable_fee_amount: number | null
  nonrefundable_fee_label: string | null
  prorated_rent_amount: number | null
  nsf_fee_amount: number | null
  status: 'pending' | 'active' | 'ended'
  late_fee_auto_apply: boolean
  /** The one-off late fee; late_fee_daily_* is charged on top, per day. */
  late_fee_type: 'flat' | 'percent' | null
  late_fee_amount: number | null
  late_fee_grace_days: number | null
  late_fee_daily_amount: number | null
  late_fee_daily_start_days: number | null
  fee_payer: 'landlord' | 'tenant'
  smoking_policy: 'not_permitted' | 'permitted' | 'outdoors_only'
  pets_allowed: boolean
  pets_description: string | null
  pet_rent_amount: number | null
  renters_insurance_required: boolean
  parking_description: string | null
  /** Utility name -> who pays. See db/migrations/007_lease_terms.sql. */
  utilities: Record<string, 'tenant' | 'landlord' | 'na'>
  additional_terms: string | null
}

const LEASE_COLUMNS =
  'id, unit_id, start_date, end_date, rent_amount, rent_due_day, deposit_amount, ' +
  'pet_deposit_amount, other_deposit_amount, other_deposit_label, ' +
  'nonrefundable_fee_amount, nonrefundable_fee_label, prorated_rent_amount, ' +
  'nsf_fee_amount, status, late_fee_auto_apply, late_fee_type, late_fee_amount, ' +
  'late_fee_grace_days, late_fee_daily_amount, late_fee_daily_start_days, fee_payer, ' +
  'smoking_policy, pets_allowed, pets_description, pet_rent_amount, ' +
  'renters_insurance_required, parking_description, utilities, additional_terms'

export type LeaseTenant = {
  id: string
  is_primary: boolean
  org_member_id: string
}

export async function fetchLeasesForUnit(unitId: string): Promise<Lease[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('leases')
    .select(LEASE_COLUMNS)
    .eq('unit_id', unitId)
    .order('start_date', { ascending: false })
  if (error) throw error
  return data as unknown as Lease[]
}

export type NewLease = {
  unitId: string
  startDate: string
  endDate: string | null
  rentAmount: number
  rentDueDay: number
  depositAmount: number
  petDepositAmount: number | null
  otherDepositAmount: number | null
  otherDepositLabel: string | null
  nonrefundableFeeAmount: number | null
  nonrefundableFeeLabel: string | null
  proratedRentAmount: number | null
  nsfFeeAmount: number | null
  lateFeeAutoApply: boolean
  lateFeeType: 'flat' | 'percent' | null
  lateFeeAmount: number | null
  lateFeeGraceDays: number | null
  lateFeeDailyAmount: number | null
  lateFeeDailyStartDays: number | null
  feePayer: 'landlord' | 'tenant'
  smokingPolicy: 'not_permitted' | 'permitted' | 'outdoors_only'
  petsAllowed: boolean
  petsDescription: string | null
  petRentAmount: number | null
  rentersInsuranceRequired: boolean
  parkingDescription: string | null
  utilities: Record<string, 'tenant' | 'landlord' | 'na'>
  additionalTerms: string | null
}

/**
 * The services a lease normally allocates. Not stored in the database —
 * a lease's `utilities` map holds only what was actually decided, so a
 * property with no HOA never carries an "HOA dues: N/A" row.
 */
export const UTILITY_NAMES = [
  'Electric', 'Gas', 'Water', 'Sewer / Septic', 'Trash', 'Internet',
  'Cable / Satellite', 'Lawn care', 'Snow removal', 'HOA dues',
] as const

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
      pet_deposit_amount: input.petDepositAmount,
      other_deposit_amount: input.otherDepositAmount,
      other_deposit_label: input.otherDepositLabel,
      nonrefundable_fee_amount: input.nonrefundableFeeAmount,
      nonrefundable_fee_label: input.nonrefundableFeeLabel,
      prorated_rent_amount: input.proratedRentAmount,
      nsf_fee_amount: input.nsfFeeAmount,
      status: 'active',
      late_fee_auto_apply: input.lateFeeAutoApply,
      late_fee_type: input.lateFeeType,
      late_fee_amount: input.lateFeeAmount,
      late_fee_grace_days: input.lateFeeGraceDays,
      late_fee_daily_amount: input.lateFeeDailyAmount,
      late_fee_daily_start_days: input.lateFeeDailyStartDays,
      fee_payer: input.feePayer,
      smoking_policy: input.smokingPolicy,
      pets_allowed: input.petsAllowed,
      pets_description: input.petsDescription,
      pet_rent_amount: input.petRentAmount,
      renters_insurance_required: input.rentersInsuranceRequired,
      parking_description: input.parkingDescription,
      utilities: input.utilities,
      additional_terms: input.additionalTerms,
    })
    .select(LEASE_COLUMNS)
    .single()
  if (error) throw error
  return data as unknown as Lease
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

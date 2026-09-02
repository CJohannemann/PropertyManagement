import { supabase } from './supabase'

export type StateRegulation = {
  state_code: string
  max_late_fee_type: 'percent' | 'flat' | 'none' | null
  max_late_fee_value: number | null
  min_grace_days: number
  tenant_paid_processing_fee_allowed: boolean | null
  source_citation: string | null
}

/**
 * The rent-law limits for a state, or null when that state has no verified
 * row yet. Null is meaningfully different from "no limits": db/schema.sql's
 * enforce_late_fee_limits trigger rejects auto late fees and tenant-paid
 * processing fees outright for an unverified state, so the lease form uses
 * this to disable those controls up front rather than let someone fill in a
 * form that the database will refuse to save.
 */
export async function fetchStateRegulation(
  stateCode: string,
): Promise<StateRegulation | null> {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('state_rent_regulations')
    .select(
      'state_code, max_late_fee_type, max_late_fee_value, min_grace_days, tenant_paid_processing_fee_allowed, source_citation',
    )
    .eq('state_code', stateCode.toUpperCase())
    .maybeSingle()
  if (error) throw error
  return (data as StateRegulation | null) ?? null
}

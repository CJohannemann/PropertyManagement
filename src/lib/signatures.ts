import { supabase } from './supabase'

export type LeaseSignature = {
  id: string
  lease_id: string
  org_member_id: string
  signer_role: 'tenant' | 'landlord'
  signed_name: string
  signed_at: string
  ip_address: string | null
  document_hash: string
}

export type SigningStatus = {
  lease_id: string
  tenant_signed: boolean
  landlord_signed: boolean
  fully_executed: boolean
  last_signed_at: string | null
}

export async function fetchSignatures(leaseId: string): Promise<LeaseSignature[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('lease_signatures')
    .select('id, lease_id, org_member_id, signer_role, signed_name, signed_at, ip_address, document_hash')
    .eq('lease_id', leaseId)
    .order('signed_at')
  if (error) throw error
  return data as LeaseSignature[]
}

export async function fetchSigningStatus(leaseId: string): Promise<SigningStatus | null> {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('lease_signing_status')
    .select('lease_id, tenant_signed, landlord_signed, fully_executed, last_signed_at')
    .eq('lease_id', leaseId)
    .maybeSingle()
  if (error) throw error
  return (data as SigningStatus | null) ?? null
}

/**
 * Wraps sign_lease(). The snapshot of what was signed is taken
 * server-side from the database; `seenText` is the document as it was
 * rendered on screen, stored alongside because retention is about the
 * document a person actually read — but it is not what the record relies
 * on, since a browser could send anything.
 */
export async function signLease(
  leaseId: string, typedName: string, consent: boolean, seenText?: string,
): Promise<string> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.rpc('sign_lease', {
    target_lease: leaseId,
    typed_name: typedName,
    consent,
    seen_text: seenText ?? null,
  })
  if (error) throw error
  return data as string
}

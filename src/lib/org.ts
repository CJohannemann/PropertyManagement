import { supabase } from './supabase'

export type OrgRole = 'admin' | 'property_manager' | 'technician' | 'tenant'

export type Membership = {
  id: string
  organization_id: string
  role: OrgRole
  status: 'invited' | 'active' | 'disabled'
}

/**
 * The signed-in user's own org_members row(s) — RLS always allows reading
 * your own row (see db/schema.sql's org_members_read policy), no matter
 * what org or role it is. An empty array means a brand-new account with no
 * organization yet, which is what routes them to /setup.
 */
export async function fetchMyMemberships(): Promise<Membership[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('org_members')
    .select('id, organization_id, role, status')
    .eq('status', 'active')
  if (error) throw error
  return data ?? []
}

export async function fetchOrganizationName(orgId: string): Promise<string> {
  if (!supabase) return ''
  const { data, error } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .single()
  if (error) throw error
  return data.name as string
}

/**
 * Wraps db/schema.sql's create_organization() — the only way to create an
 * org and become its admin, since ordinary RLS can't authorize joining an
 * org that doesn't exist yet (see that function's own comment).
 */
export async function createOrganization(name: string): Promise<string> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.rpc('create_organization', { org_name: name })
  if (error) throw error
  return data as string
}

/** Wraps db/schema.sql's accept_invite(). Requires an authenticated session. */
export async function acceptInvite(token: string): Promise<string> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.rpc('accept_invite', { invite_token: token })
  if (error) throw error
  return data as string
}

/**
 * Wraps db/schema.sql's create_invite(). Admins can invite any role;
 * property managers can only invite tenants (enforced server-side by the
 * function itself, not just here). A tenant invite must carry a lease id.
 */
export async function createInvite(
  email: string,
  role: OrgRole,
  leaseId?: string,
  fullName?: string,
): Promise<{ token: string; expires_at: string }> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.rpc('create_invite', {
    invite_email: email,
    wanted_role: role,
    wanted_lease_id: leaseId ?? null,
    invite_full_name: fullName ?? null,
  })
  if (error) throw error
  const rows = data as { token: string; expires_at: string }[]
  return rows[0]
}

import { supabase } from './supabase'

export type OrgRole = 'admin' | 'property_manager' | 'technician' | 'tenant'

export type Membership = {
  id: string
  organization_id: string
  role: OrgRole
  status: 'invited' | 'active' | 'disabled'
}

/**
 * Most privileged first. Which membership the app picks decides which
 * dashboard someone lands on, and picking whichever row the database
 * happened to return first meant an owner could open the app and be shown
 * the tenant view — with a rent balance — because of row order.
 */
const ROLE_RANK: Record<OrgRole, number> = {
  admin: 0, property_manager: 1, technician: 2, tenant: 3,
}

/**
 * The signed-in user's own org_members row(s). An empty array means a
 * brand-new account with no organization yet, which routes them to /setup.
 *
 * The user_id filter is load-bearing and must not be dropped as
 * redundant-looking. RLS does NOT restrict this table to your own row: an
 * admin or property manager is deliberately allowed to read the whole
 * roster, because managing people requires seeing them. Leaving the filter
 * off returned every active member of the organization, and the sort below
 * then handed a property manager the *admin's* row — showing them the
 * admin dashboard, under the admin's membership id, so anything they
 * created would have been attributed to the admin.
 *
 * Sorted most-privileged first so someone holding roles in more than one
 * organization lands somewhere deterministic rather than on whichever row
 * came back first.
 */
export async function fetchMyMemberships(): Promise<Membership[]> {
  if (!supabase) return []
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
  if (!userId) return []

  const { data, error } = await supabase
    .from('org_members')
    .select('id, organization_id, role, status')
    .eq('user_id', userId)
    .eq('status', 'active')
  if (error) throw error
  return (data ?? []).sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role])
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

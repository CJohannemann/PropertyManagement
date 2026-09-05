import { supabase } from './supabase'

/**
 * Calls the payments API (server/), which lives behind /api on this same
 * origin — see deploy/nginx-property-management.conf.
 *
 * Everything else in this app talks to PostgREST directly under row-level
 * security. This exists only for the things a browser must not be trusted
 * with: anything holding Stripe's secret key.
 */
export async function apiFetch<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  if (!supabase) throw new Error('Supabase not configured')

  // The same access token PostgREST already receives. The API verifies it
  // against JWT_SECRET and then re-derives the caller's authority from the
  // database — the token establishes who, never what they may do.
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('You are not signed in')

  // A body implies POST unless told otherwise — a GET carrying one is
  // invalid, and silently sending it would fail somewhere less obvious.
  const method = init.method ?? (init.body ? 'POST' : 'GET')

  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  })

  if (!res.ok) {
    // The API returns { error } for anything it refuses deliberately.
    // Anything else is a bug or an outage, and the status is more useful
    // than an empty message.
    const problem = await res.json().catch(() => null)
    throw new Error(problem?.error ?? `Request failed (${res.status})`)
  }

  return res.json() as Promise<T>
}

import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL ?? ''
const key = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

/**
 * Whether .env holds real credentials. Unlike FarmHand this app has no
 * local-only mode — there's nothing useful to show without a backend — so
 * this only gates a friendly setup message instead of a real fallback.
 *
 * Requires https, with plain http allowed only against localhost for
 * development. This app carries lease terms, rent balances and (soon)
 * payment flows, so an http:// backend URL in a real deployment means
 * session tokens crossing the network in the clear — worth refusing to
 * start over rather than quietly working.
 */
const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$|\/)/.test(url)

export const supabaseConfigured =
  (url.startsWith('https://') || (isLocalhost && url.startsWith('http://'))) &&
  key.length > 20

export const supabase = supabaseConfigured
  ? createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : null

/**
 * postgrest-js swallows the real cause of a client-side network failure (a
 * raw fetch() rejection — DNS, TLS, an aborted request) into a bare
 * `TypeError: Load failed`/`Failed to fetch` on `.message`, but stashes the
 * actual detail on `.details`/`.hint` instead. Surfacing all three avoids a
 * dead-end error that's only reproducible on one specific device. Same
 * pattern as FarmHand's lib/supabase.ts — see its comment for the fuller
 * story of how this was found.
 */
export function describeError(error: {
  message: string
  hint?: string | null
  details?: string | null
}): string {
  const parts = [error.message]
  if (error.hint) parts.push(`hint: ${error.hint}`)
  if (error.details) parts.push(`details: ${error.details}`)
  return parts.join(' — ')
}

/**
 * Anything thrown, as something a person can read.
 *
 * The catch blocks in this app used to do
 *
 *   e instanceof Error ? e.message : String(e)
 *
 * which is right for a thrown Error and useless for everything postgrest-js
 * throws. Its errors are plain objects — `{ message, details, hint, code }`,
 * not Error instances — so they fell to `String(e)` and rendered on screen
 * as the literal text "[object Object]". Reported from real use, where a
 * missing database function showed up that way: the app had been told
 * exactly what was wrong and threw the explanation away.
 *
 * Falls back to JSON rather than String() for the same reason — an
 * unrecognised object should still show something diagnosable.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e
      && typeof (e as { message: unknown }).message === 'string') {
    return describeError(e as { message: string; hint?: string | null; details?: string | null })
  }
  if (e && typeof e === 'object') {
    try {
      return JSON.stringify(e)
    } catch {
      return 'An unexpected error occurred.'
    }
  }
  return String(e)
}

/**
 * Turning a URL path into a screen, and back.
 *
 * Import-free on purpose, like owed.ts and leaseDates.ts: route.ts itself
 * imports Capacitor and reaches for `window`, so it cannot be loaded by a
 * plain Node test. The parsing is the part with rules in it, so it lives
 * here where db/test/routing.mjs can exercise it.
 */

export type Route =
  | '/'
  | '/login'
  | '/signup'
  | '/setup'
  | '/accept-invite'
  | '/reset-password'
  | '/dashboard'
  | '/rent'
  | '/maintenance'
  | '/properties'
  | '/settings'

export type Location =
  | { route: Route; id?: string }
  | { route: 'not-found' }

export const ROUTES: Route[] = [
  '/', '/login', '/signup', '/setup', '/accept-invite', '/reset-password',
  '/dashboard', '/rent', '/maintenance', '/properties', '/settings',
]

/** The screens inside the signed-in app shell, in nav order. */
export const APP_SECTIONS: { route: Route; label: string }[] = [
  { route: '/dashboard', label: 'Home' },
  { route: '/rent', label: 'Rent' },
  { route: '/maintenance', label: 'Repairs' },
  { route: '/properties', label: 'Properties' },
]

/** Screens that mean nothing signed out, and bounce to the sign-in page. */
export const SIGNED_IN_ONLY: string[] = [
  '/', '/dashboard', '/rent', '/maintenance', '/properties', '/settings',
  '/setup', '/reset-password',
]

export function parsePath(rawPath: string): Location {
  // A trailing slash is the same screen; "/rent/" and "/rent" must not be
  // one route and one 404.
  const path = rawPath.replace(/\/+$/, '') || '/'

  if ((ROUTES as string[]).includes(path)) return { route: path as Route }

  // One level of parameter: /properties/<id>. Deliberately not a general
  // pattern matcher — there is exactly one parameterised screen, and a
  // route list is easier to read than a matcher that could handle
  // anything.
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 2 && parts[0] === 'properties') {
    // Decoding can throw on a malformed escape ("%zz"); a bad URL is a
    // 404, not a crashed app.
    try {
      return { route: '/properties', id: decodeURIComponent(parts[1]) }
    } catch {
      return { route: 'not-found' }
    }
  }

  return { route: 'not-found' }
}

export function hrefFor(to: Route, id?: string): string {
  return id ? `${to}/${encodeURIComponent(id)}` : to
}

import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'

/**
 * The whole router — same reasoning as FarmHand's lib/route.ts: a handful
 * of top-level screens chosen by URL, no nested routes, no params beyond a
 * query string. A dependency like react-router would be more code to
 * configure than the thing it replaces.
 *
 * nginx needs `try_files $uri /index.html` once the frontend is actually
 * deployed (not yet — see deploy/selfhost/README.md) for these to be real,
 * refreshable URLs rather than a pushState illusion that 404s on reload.
 */
export type Route =
  | '/'
  | '/login'
  | '/signup'
  | '/setup'
  | '/accept-invite'
  | '/reset-password'
  | '/dashboard'

export type Location = Route | 'not-found'

const ROUTES: Route[] = [
  '/',
  '/login',
  '/signup',
  '/setup',
  '/accept-invite',
  '/reset-password',
  '/dashboard',
]

/**
 * A native build has no address bar and always boots index.html at '/' —
 * send it straight to the app shell rather than a marketing page that
 * doesn't exist yet anyway.
 */
export function isNative(): boolean {
  return Capacitor.isNativePlatform()
}

function read(): Location {
  if (isNative()) return '/dashboard'
  const path = window.location.pathname.replace(/\/+$/, '') || '/'
  return (ROUTES as string[]).includes(path) ? (path as Route) : 'not-found'
}

/**
 * pushState deliberately does NOT fire popstate — that event is for the
 * back button — so navigate() re-dispatches it by hand to tell useRoute()
 * something changed.
 */
export function navigate(to: Route, opts: { replace?: boolean } = {}): void {
  if (read() === to) return
  if (opts.replace) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function useRoute(): Location {
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const onPop = () => setRoute(read())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  return route
}

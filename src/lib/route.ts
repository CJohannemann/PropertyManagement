import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { parsePath, hrefFor, type Location, type Route } from './routePaths'

/**
 * The whole router — same reasoning as FarmHand's lib/route.ts: a handful
 * of screens chosen by URL. A dependency like react-router would be more
 * code to configure than the thing it replaces.
 *
 * The path rules live in routePaths.ts, which imports nothing, so they can
 * be tested without a browser. This file is the browser half: reading
 * location, pushing history, and telling React.
 *
 * nginx serves index.html for unknown paths (`try_files $uri /index.html`
 * in deploy/nginx-property-management.conf), so these are real refreshable
 * URLs rather than a pushState illusion that 404s on reload.
 */
export { APP_SECTIONS, SIGNED_IN_ONLY } from './routePaths'
export type { Route, Location } from './routePaths'

/**
 * A native build has no address bar and always boots index.html at '/' —
 * send it straight to the app shell rather than a marketing page that
 * doesn't exist yet anyway.
 */
export function isNative(): boolean {
  return Capacitor.isNativePlatform()
}

function read(): Location {
  if (isNative()) return { route: '/dashboard' }
  return parsePath(window.location.pathname)
}

/**
 * pushState deliberately does NOT fire popstate — that event is for the
 * back button — so navigate() re-dispatches it by hand to tell useRoute()
 * something changed.
 */
export function navigate(to: Route, opts: { replace?: boolean; id?: string } = {}): void {
  const target = hrefFor(to, opts.id)
  if (window.location.pathname.replace(/\/+$/, '') === target.replace(/\/+$/, '')) return
  if (opts.replace) window.history.replaceState(null, '', target)
  else window.history.pushState(null, '', target)
  window.dispatchEvent(new PopStateEvent('popstate'))
  // A new screen starts at its top. Without this, tapping into a property
  // from halfway down a list opens the property halfway down.
  window.scrollTo(0, 0)
}

export function useRoute(): Location {
  const [location, setLocation] = useState(read)
  useEffect(() => {
    const onPop = () => setLocation(read())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  return location
}

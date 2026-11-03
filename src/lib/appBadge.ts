/**
 * The red count on the app's home-screen icon.
 *
 * Uses the Badging API (navigator.setAppBadge). On an iPhone it works for
 * the app once it is added to the home screen and notifications are
 * allowed (iOS 16.4+); Chrome and Edge show it on an installed app too.
 * Where it doesn't exist this does nothing — the bell in the header is
 * still the count that always works.
 *
 * Set here while the app is open; the service worker (public/sw.js) sets it
 * from each push while the app is closed, using the unread count the
 * server sends with the push.
 */
type BadgeNavigator = Navigator & {
  setAppBadge?: (n?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

export function setAppBadgeCount(count: number): void {
  const nav = navigator as BadgeNavigator
  try {
    if (count > 0) nav.setAppBadge?.(count)?.catch(() => {})
    else nav.clearAppBadge?.()?.catch(() => {})
  } catch {
    // Unsupported or not permitted (no notification permission yet) —
    // the badge is a nicety, never a reason to break the page.
  }
}

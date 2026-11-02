import { supabase } from './supabase'

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY ?? ''

/** Whether this browser and this build can do Web Push at all. */
export const pushSupported =
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  VAPID_PUBLIC_KEY.length > 0

/** The browser's own permission state — not whether a subscription exists. */
export function pushPermission(): NotificationPermission | 'unsupported' {
  if (!pushSupported) return 'unsupported'
  return Notification.permission
}

// applicationServerKey needs the VAPID public key as raw bytes, not the
// base64url string it's stored as.
function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4)
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

/**
 * iPhone and iPad only offer Web Push to a site added to the home screen
 * and opened from there — in a Safari tab, PushManager simply doesn't
 * exist. Telling that case apart from "this browser can't" lets the app
 * say how to get alerts instead of silently offering nothing.
 */
export function needsHomeScreenForPush(): boolean {
  if (typeof window === 'undefined' || VAPID_PUBLIC_KEY.length === 0) return false
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true
  return ios && !standalone
}

/**
 * Asks the browser for notification permission, subscribes to Web Push,
 * and stores the subscription so
 * deploy/selfhost/send-push-notifications.mjs can find it. Must be
 * called from a user gesture (a click) — browsers ignore or block a
 * permission prompt that isn't.
 */
export async function enablePushNotifications(memberId: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  if (!pushSupported) throw new Error('This browser does not support push notifications')

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted')
  }

  const registration = await navigator.serviceWorker.register('/sw.js')
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  })
  const json = subscription.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('Subscription is missing required fields')
  }

  // Through a function rather than an upsert: if this phone was enabled
  // by a different account before (two test logins on one device), that
  // row isn't ours to update, and the device should follow whoever turned
  // notifications on most recently. See db/migrations/032.
  const { error } = await supabase.rpc('register_push_subscription', {
    member: memberId,
    sub_endpoint: json.endpoint,
    sub_p256dh: json.keys.p256dh,
    sub_auth: json.keys.auth,
  })
  if (error) throw error
}

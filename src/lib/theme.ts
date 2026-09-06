import { useCallback, useEffect, useState } from 'react'

/**
 * Light, dark, or follow the device.
 *
 * The palette for all three has been in index.css since the tokens were
 * written — `:root` is light, `:root[data-theme="dark"]` is dark, and the
 * `prefers-color-scheme` block covers "system" — and its comment has said
 * "no theme switcher built yet" ever since. This is that switcher. Nothing
 * about the colors changes here; this only decides which set applies.
 *
 * "system" is stored as the ABSENCE of the attribute, not as
 * data-theme="system", because that is what the media query in index.css
 * keys off. Following the device is also the default, so it is stored by
 * removing the key rather than writing a value — someone who never touches
 * this setting keeps following their OS even if the default were to change
 * later.
 */
export type ThemePreference = 'system' | 'light' | 'dark'

/**
 * Also read by the inline script in index.html, which applies the stored
 * theme before the first paint so an explicit choice doesn't flash the
 * other palette while the bundle loads. Change one, change both.
 */
const KEY = 'pm_theme'

export const THEME_CHOICES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

export function storedTheme(): ThemePreference {
  const raw = localStorage.getItem(KEY)
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement
  if (preference === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', preference)
}

export function storeTheme(preference: ThemePreference): void {
  if (preference === 'system') localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, preference)
  applyTheme(preference)
}

/**
 * The preference and a setter, for the controls that offer the choice.
 *
 * The storage listener keeps two open tabs in step: changing the theme in
 * one used to leave the other on the old palette until it was reloaded,
 * which reads as the setting not having worked. `storage` fires only in
 * OTHER tabs, so this never fights the tab doing the changing.
 */
export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(storedTheme)

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEY && e.key !== null) return
      const next = storedTheme()
      setPreference(next)
      applyTheme(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const choose = useCallback((next: ThemePreference) => {
    storeTheme(next)
    setPreference(next)
  }, [])

  return [preference, choose]
}

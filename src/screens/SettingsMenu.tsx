import { useEffect, useRef, useState } from 'react'
import { navigate } from '../lib/route'
import { useThemePreference, THEME_CHOICES } from '../lib/theme'

type Props = {
  /** Admins and property managers have a settings screen; the others don't. */
  canOpenSettings: boolean
  onSignOut: () => void
}

/**
 * The gear in the header: appearance, settings, sign out.
 *
 * Sign out used to be a bare link sitting in the header on every screen,
 * which put the one irreversible control in the app permanently next to
 * the notification bell — easy to hit by accident on a phone, and it left
 * nowhere to put anything else. Account-level things collect here instead.
 *
 * The appearance control lives in this menu rather than only on the
 * settings screen because a tenant and a technician have no settings
 * screen at all, and choosing dark mode should not be a thing only
 * landlords can do.
 */
export function SettingsMenu({ canOpenSettings, onSignOut }: Props) {
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useThemePreference()
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Dismissal. A menu that only closes by picking something from it is a
  // trap on a phone, where there is no Escape key and tapping the page
  // behind it is the instinct.
  useEffect(() => {
    if (!open) return

    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      setOpen(false)
      // Focus goes back to the gear rather than to the top of the page,
      // so closing with the keyboard leaves you where you opened it.
      buttonRef.current?.focus()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div style={{ position: 'relative' }} ref={wrapRef}>
      <button
        ref={buttonRef}
        className="link"
        onClick={() => setOpen((s) => !s)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Settings and account"
        style={{ fontSize: '1.1rem', lineHeight: 1 }}
      >
        <span aria-hidden="true">⚙️</span>
      </button>

      {open && (
        <div className="menu-panel">
          <div className="menu-label" id="appearance-label">Appearance</div>
          {/* Three radios, not a light/dark switch: "follow my device" is a
              real answer and a two-state toggle cannot express it. */}
          <div className="seg" role="radiogroup" aria-labelledby="appearance-label">
            {THEME_CHOICES.map((choice) => (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={theme === choice.value}
                className={theme === choice.value ? 'seg-item is-current' : 'seg-item'}
                onClick={() => setTheme(choice.value)}
              >
                {choice.label}
              </button>
            ))}
          </div>

          <div className="menu-divider" />

          {canOpenSettings && (
            <button
              className="menu-item"
              onClick={() => { setOpen(false); navigate('/settings') }}
            >
              Settings
            </button>
          )}
          <button className="menu-item" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

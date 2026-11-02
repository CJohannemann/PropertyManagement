import { useEffect, useRef, useState } from 'react'

type Props = {
  url: string
  /** Used as the share sheet's message, e.g. "Your lease invite". */
  shareTitle?: string
}

/**
 * A link someone needs to send on: the URL, a Copy button, and — on phones,
 * where the next step is usually a text message — a Share button that opens
 * the system share sheet.
 *
 * Selecting the field by hand still works, for anyone who prefers it, but
 * selecting a long URL in a tiny field on a phone is fiddly enough that it
 * was the step people got stuck on.
 */
export function CopyLink({ url, shareTitle }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  // "Copied" is a confirmation, not a state: it fades so a second copy
  // gets a second confirmation.
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(null), 2500)
    return () => clearTimeout(t)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied('yes')
      return
    } catch {
      // The async clipboard API is missing on older browsers and refused on
      // a non-secure origin; the old select-and-copy route still works there.
    }
    const el = input.current
    if (el) {
      el.focus()
      el.select()
      el.setSelectionRange(0, url.length)
      try {
        setCopied(document.execCommand('copy') ? 'yes' : 'failed')
        return
      } catch { /* fall through */ }
    }
    setCopied('failed')
  }

  async function share() {
    try {
      await navigator.share({ title: shareTitle, text: shareTitle, url })
    } catch {
      // Dismissing the share sheet rejects too; that isn't an error worth
      // showing.
    }
  }

  return (
    <div>
      <input
        ref={input}
        readOnly
        value={url}
        aria-label="Invite link"
        onClick={(e) => e.currentTarget.select()}
        style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
      />
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
        <button type="button" className="seg-item is-current" onClick={copy}
          style={{ flex: 1 }}>
          {copied === 'yes' ? '✓ Copied' : 'Copy link'}
        </button>
        {canShare && (
          <button type="button" className="seg-item" onClick={share} style={{ flex: 1 }}>
            Share…
          </button>
        )}
      </div>
      <p className="muted" role="status" aria-live="polite" style={{ minHeight: '1.2em', margin: '0.35rem 0 0' }}>
        {copied === 'yes' && 'Copied — paste it into a text or email.'}
        {copied === 'failed' && 'Couldn’t copy automatically — press and hold the link to copy it.'}
      </p>
    </div>
  )
}

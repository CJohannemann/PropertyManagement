import { errorMessage } from '../lib/supabase'
import { useEffect, useState } from 'react'
import {
  fetchSignatures, signLease, type LeaseSignature,
} from '../lib/signatures'

type Props = {
  leaseId: string
  /** The document as rendered on screen, stored as what the signer read. */
  renderedText: string
  onSigned: () => void
}

/**
 * Signing panel.
 *
 * Kentucky adopted UETA (KRS Chapter 369), under which an electronic
 * signature is enforceable given intent to sign, consent to transact
 * electronically, association with the specific record, and retention.
 * The two checkboxes below are not decoration: they are the consent and
 * the intent, kept separate because agreeing to use electronic records
 * and agreeing to the lease are different agreements, and bundling them
 * into one tick makes both weaker.
 */
export function SignLease({ leaseId, renderedText, onSigned }: Props) {
  const [signatures, setSignatures] = useState<LeaseSignature[] | null>(null)
  const [consent, setConsent] = useState(false)
  const [agree, setAgree] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      setSignatures(await fetchSignatures(leaseId))
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  useEffect(() => { load() }, [leaseId])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      await signLease(leaseId, name, consent, renderedText)
      await load()
      onSigned()
    } catch (err) {
      setError(errorMessage(err))
    }
    setBusy(false)
  }

  if (signatures === null) return <p className="muted">Loading…</p>

  const tenant = signatures.find((s) => s.signer_role === 'tenant')
  const landlord = signatures.find((s) => s.signer_role === 'landlord')

  return (
    <div className="card-list">
      <div>
        <h3 style={{ marginTop: 0 }}>Signatures</h3>

        <div className="muted" style={{ marginBottom: '1rem' }}>
          <div>
            Tenant: {tenant
              ? `signed by ${tenant.signed_name} on ${tenant.signed_at.slice(0, 10)}`
              : 'not signed yet'}
          </div>
          <div>
            Landlord: {landlord
              ? `signed by ${landlord.signed_name} on ${landlord.signed_at.slice(0, 10)}`
              : 'not signed yet'}
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}

        {/* The RPC refuses a second signature from the same person, but
            showing the form to someone who has already signed invites an
            error rather than preventing one. */}
        {signatures.length > 0 && error?.includes('already signed') ? null : (
          <form onSubmit={submit}>
            <div className="field">
              <label>
                <input type="checkbox" checked={consent}
                  onChange={(e) => setConsent(e.target.checked)} />
                {' '}I agree to sign this lease electronically and to receive
                records about it electronically.
              </label>
              <span className="muted">
                You can ask for a paper copy instead — signing here is not
                the only way to enter this agreement.
              </span>
            </div>

            <div className="field">
              <label>
                <input type="checkbox" checked={agree}
                  onChange={(e) => setAgree(e.target.checked)} />
                {' '}I have read the agreement above and I agree to its terms.
              </label>
            </div>

            <div className="field">
              <label htmlFor="sig-name">Type your full legal name to sign</label>
              <input id="sig-name" type="text" value={name} required
                autoComplete="name"
                onChange={(e) => setName(e.target.value)} />
            </div>

            <button className="primary" type="submit"
              disabled={busy || !consent || !agree || name.trim() === ''}>
              {busy ? 'Signing…' : 'Sign lease'}
            </button>

            <p className="muted" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
              Signing records your name, the date and time, and a copy of
              this agreement exactly as it appears above. Later edits to the
              lease do not change what you signed.
            </p>
          </form>
        )}
      </div>
    </div>
  )
}

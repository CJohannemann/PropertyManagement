import { errorMessage, supabase } from '../lib/supabase'
import { useEffect, useState } from 'react'
import {
  fetchSignatures, signLease, type LeaseSignature,
} from '../lib/signatures'

type Props = {
  leaseId: string
  /** The document as rendered on screen, stored as what the signer read. */
  renderedText: string
  onSigned: () => void
  /** Leaves the lease screen — offered once the viewer has signed. */
  onDone?: () => void
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
export function SignLease({ leaseId, renderedText, onSigned, onDone }: Props) {
  const [signatures, setSignatures] = useState<LeaseSignature[] | null>(null)
  const [consent, setConsent] = useState(false)
  const [agree, setAgree] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The viewer's own membership ids, to tell "I have signed" from "someone
  // has signed". Several tenants can be on one lease, and a landlord's
  // signature is not the tenant's.
  const [myIds, setMyIds] = useState<string[] | null>(null)
  const [justSigned, setJustSigned] = useState(false)

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user || !supabase) return setMyIds([])
      const { data: rows } = await supabase
        .from('org_members').select('id').eq('user_id', data.user.id)
      setMyIds((rows ?? []).map((r: { id: string }) => r.id))
    })
  }, [])

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
      setJustSigned(true)
      onSigned()
    } catch (err) {
      setError(errorMessage(err))
    }
    setBusy(false)
  }

  if (signatures === null) return <p className="muted">Loading…</p>

  const tenant = signatures.find((s) => s.signer_role === 'tenant')
  const landlord = signatures.find((s) => s.signer_role === 'landlord')
  const mine = signatures.find((s) => myIds?.includes(s.org_member_id))

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

        {/* Once you've signed, the form is replaced by a confirmation.
            It used to stay on screen, filled in, after a successful
            signature — the only change was the status line at the top of
            this card, out of view — so signing looked like it had done
            nothing, and the second tap was the first anyone heard of it
            (as an "already signed" error). */}
        {mine ? (
          <div role="status" style={{
            border: '1px solid var(--accent)', borderRadius: 8, padding: '0.9rem',
          }}>
            <strong>✓ {justSigned ? 'Signed.' : 'You\u2019ve signed this lease.'}</strong>
            <div className="muted" style={{ marginTop: '0.25rem' }}>
              Signed by {mine.signed_name} on {mine.signed_at.slice(0, 10)}.{' '}
              {mine.signer_role === 'tenant'
                ? (landlord
                    ? 'Your landlord has signed too — the lease is in effect. Use Print / Save as PDF at the top to keep a copy.'
                    : 'Your landlord will countersign next. You don\u2019t need to do anything else.')
                : (tenant
                    ? 'Both sides have signed — the lease is in effect.'
                    : 'Waiting for the tenant to sign.')}
            </div>
            {onDone && (
              <button className="primary" style={{ marginTop: '0.75rem' }} onClick={onDone}>
                Done
              </button>
            )}
          </div>
        ) : myIds === null ? null : (
          <>
        {error && <p className="error-text">{error}</p>}

        {(
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
          </>
        )}
      </div>
    </div>
  )
}

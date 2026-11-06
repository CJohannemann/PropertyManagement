import { useEffect, useState } from 'react'
import { supabase, describeError, errorMessage } from '../../lib/supabase'
import {
  fetchCharges, outstanding, totalOutstanding, isOverdue, statusLabel, money, chargeLabel,
  methodLabel,
  type ChargeWithPlace,
} from '../../lib/charges'
import {
  fetchRequests, REQUEST_STATUS_LABEL, friendlyDate, type MaintenanceRequest,
} from '../../lib/maintenance'
import { RequestRepair } from '../RequestRepair'
import { RequestPhotos } from '../RequestPhotos'
import { TenantLease } from '../TenantLease'
import { PayRent } from '../PayRent'
import { stripeConfigured } from '../../lib/payments'
import { fetchSigningStatus, type SigningStatus } from '../../lib/signatures'

type Lease = {
  id: string
  unit_id: string
  rent_amount: number
  status: string
  start_date: string
  end_date: string | null
  /** Set once the lease has ended (033). */
  ended_on?: string | null
  rent_due_day: number
  deposit_amount: number
  fee_payer: 'landlord' | 'tenant'
}

type Props = { memberId: string }

export function TenantDashboard({ memberId }: Props) {
  const [leases, setLeases] = useState<Lease[] | null>(null)
  const [charges, setCharges] = useState<ChargeWithPlace[] | null>(null)
  const [requests, setRequests] = useState<MaintenanceRequest[]>([])
  const [reporting, setReporting] = useState(false)
  const [paying, setPaying] = useState<ChargeWithPlace | null>(null)
  const [viewingLease, setViewingLease] = useState(false)
  const [signing, setSigning] = useState<SigningStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Charges the tenant has just started paying, and when. Stripe tells the
  // server about a payment by webhook, a few seconds to a minute after the
  // tenant taps Pay — so straight after paying, the charge still reads as
  // unpaid. Until the server catches up, these are shown as on their way,
  // and the list is re-read until it does.
  const [justPaid, setJustPaid] = useState<Record<string, number>>({})

  useEffect(() => {
    if (!supabase) return
    // No explicit filter — RLS already scopes both to this tenant.
    supabase
      .from('leases')
      .select('id, unit_id, rent_amount, status, start_date, end_date, ended_on, rent_due_day, deposit_amount, fee_payer')
      .then(({ data, error }) => {
        if (error) setError(describeError(error))
        // The current lease first. Someone who moved units, or whose old
        // lease ended, can see more than one — and leases[0] is what this
        // whole screen is about.
        else setLeases((data as unknown as Lease[]).sort((a, b) =>
          Number(a.status === 'ended') - Number(b.status === 'ended')
          || b.start_date.localeCompare(a.start_date)))
      })
    fetchCharges()
      .then(setCharges)
      .catch((e) => setError(errorMessage(e)))
    loadRequests()
  }, [])

  // Signing status decides whether the dashboard leads with 'read and
  // sign' or with the balance — a tenant who has not agreed to anything
  // should not be greeted by a bill.
  useEffect(() => {
    if (leases && leases.length > 0) {
      fetchSigningStatus(leases[0].id).then(setSigning).catch(() => setSigning(null))
    }
  }, [leases])

  // Re-read while a just-started payment hasn't reached the server yet, or
  // one is still 'processing' — every 5s for the first three minutes after
  // paying, which in Stripe's sandbox covers it settling too. Past that a
  // real bank transfer takes days, so polling stops and the list refreshes
  // whenever the tenant comes back to the app instead.
  const inFlight = (charges ?? []).some(hasPaymentOnItsWay)
  const pending = Object.keys(justPaid).length > 0
  useEffect(() => {
    const latest = Math.max(0, ...Object.values(justPaid))
    if (!pending && !inFlight) return
    if (Date.now() - latest > 3 * 60_000) return
    const t = setInterval(() => {
      if (Date.now() - latest > 3 * 60_000) { clearInterval(t); return }
      loadCharges()
    }, 5000)
    return () => clearInterval(t)
  }, [pending, inFlight, justPaid])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') loadCharges()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // Once the server knows about a payment, the local note is redundant.
  useEffect(() => {
    if (!charges) return
    setJustPaid((cur) => {
      const next = { ...cur }
      let changed = false
      for (const c of charges) {
        if (next[c.id] && (hasPaymentOnItsWay(c) || outstanding(c) <= 0)) {
          delete next[c.id]; changed = true
        }
      }
      return changed ? next : cur
    })
  }, [charges])

  function loadRequests() {
    fetchRequests()
      .then(setRequests)
      .catch((e) => setError(errorMessage(e)))
  }

  function loadCharges() {
    fetchCharges()
      .then(setCharges)
      .catch((e) => setError(errorMessage(e)))
  }

  if (error) return <p className="error-text">{error}</p>
  if (leases === null || charges === null) return <p className="muted">Loading…</p>

  if (leases.length === 0) {
    return <p className="empty-state">No lease on file yet.</p>
  }

  if (paying) {
    return (
      <PayRent
        charge={paying}
        onDone={(started) => {
          if (started) setJustPaid((cur) => ({ ...cur, [paying.id]: Date.now() }))
          setPaying(null)
          // An ACH payment is only 'processing' at this point, so the
          // balance won't have moved — but a failed start might have, and
          // re-reading is cheaper than reasoning about which.
          loadCharges()
        }}
      />
    )
  }

  if (viewingLease) {
    return (
      <TenantLease
        leaseId={leases[0].id}
        onBack={() => {
          setViewingLease(false)
          fetchSigningStatus(leases[0].id).then(setSigning).catch(() => setSigning(null))
        }}
      />
    )
  }

  const owed = totalOutstanding(charges)
  const overdue = charges.filter(isOverdue)
  const lease = leases[0]

  const ended = lease.status === 'ended'

  // An ended lease is not waiting for anyone's signature.
  if (signing && !signing.tenant_signed && !ended) {
    return (
      <div>
        <h2>Your lease is waiting for you</h2>
        <div className="card-list">
          <div>
            <p style={{ marginTop: 0 }}>
              Your landlord has set up your tenancy, but you have not agreed
              to the lease yet. Read it and, if you are happy with it, sign.
            </p>
            <p className="muted">
              Nothing is agreed until you sign, and you can ask for a paper
              copy instead.
            </p>
            <button className="primary" onClick={() => setViewingLease(true)}>
              Read and sign the lease
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      {ended && (
        <div className="card-list" style={{ marginTop: 0, marginBottom: '1.5rem' }}>
          <div>
            <strong>Your lease ended on {lease.ended_on ?? lease.end_date}.</strong>
            <div className="muted">
              {owed > 0
                ? 'You can still see and pay what\u2019s owed below. For anything else, contact your landlord.'
                : 'Nothing is owed. For anything else, contact your landlord.'}
            </div>
          </div>
        </div>
      )}
      <h2>What you owe</h2>
      <div className="card-list">
        <div>
          <div style={{ fontSize: '1.6rem', fontWeight: 600 }}>{money(owed)}</div>
          {owed === 0 ? (
            <div className="muted">You're all paid up.</div>
          ) : overdue.length > 0 ? (
            <div className="error-text" style={{ marginBottom: 0 }}>
              {money(totalOutstanding(overdue))} of this is past due.
            </div>
          ) : (
            <div className="muted">Nothing overdue.</div>
          )}
          {/* Still counted as owed — it is, until the bank clears it —
              but said, so the total doesn't read as the payment having
              been ignored. */}
          {owed > 0 && charges.some((c) => justPaid[c.id] || hasPaymentOnItsWay(c)) && (
            <div className="muted">
              A payment is on its way from your bank. This updates once it clears.
            </div>
          )}
          {owed > 0 && !stripeConfigured && (
            <p className="muted" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
              Online payment isn't available here yet — pay as you do today
              for now.
            </p>
          )}
        </div>
      </div>

      <h2 style={{ marginTop: '2rem' }}>Your charges</h2>
      {charges.length === 0 ? (
        <p className="empty-state">Nothing billed yet.</p>
      ) : (
        <div className="card-list">
          {charges.map((c) => (
            <div key={c.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>
                  {chargeLabel(c.charge_type)}
                </strong>
                <span className={isOverdue(c) ? 'error-text' : 'muted'} style={{ margin: 0 }}>
                  {statusLabel(c)}
                </span>
              </div>
              <div className="muted">
                Due {c.due_date} · {money(Number(c.amount))}
                {Number(c.amount_paid) > 0 && ` · ${money(Number(c.amount_paid))} paid`}
                {outstanding(c) > 0 && ` · ${money(outstanding(c))} left`}
              </div>
              {/* So a tenant can see their landlord recorded the check
                  they handed over, without having to ask. Voided payments
                  are left out — an entry made and unmade is the landlord's
                  correction, not something the tenant did. */}
              {(c.payments ?? [])
                .filter((p) => p.status !== 'refunded')
                .map((p) => (
                  <div key={p.id} className="muted">
                    {money(Number(p.amount))} by {methodLabel(p.method)}
                    {p.paid_at ? ` on ${p.paid_at.slice(0, 10)}` : ''}
                    {(p.status === 'pending' || p.status === 'processing')
                      && ' · on its way, not cleared yet'}
                    {p.status === 'failed' && ' · did not clear'}
                  </div>
                ))}
              {justPaid[c.id] && !hasPaymentOnItsWay(c) && (
                <div className="muted">Payment started · on its way, not cleared yet</div>
              )}
              {/* No second Pay while one is on its way — the server refuses
                  it anyway, and offering it invites paying twice. */}
              {stripeConfigured && outstanding(c) > 0
                && !justPaid[c.id] && !hasPaymentOnItsWay(c) && (
                <button className="link" onClick={() => setPaying(c)}
                  style={{ marginTop: '0.5rem' }}>
                  Pay {money(outstanding(c))}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center', marginTop: '2rem' }}>
        <h2>Repairs</h2>
        {/* Not for a unit you've left — the database refuses it too (033). */}
        {!reporting && !ended && (
          <button className="link" onClick={() => setReporting(true)}>
            + Report a problem
          </button>
        )}
      </div>
      {reporting && (
        <RequestRepair
          unitId={lease.unit_id}
          memberId={memberId}
          onDone={() => { setReporting(false); loadRequests() }}
        />
      )}
      {!reporting && requests.length === 0 && (
        <p className="empty-state">Nothing reported.</p>
      )}
      {requests.length > 0 && (
        <div className="card-list">
          {requests.map((r) => (
            <div key={r.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>{r.category}</strong>
                <span className="muted" style={{ margin: 0 }}>
                  {REQUEST_STATUS_LABEL[r.status] ?? r.status}
                </span>
              </div>
              <div>{r.description}</div>
              <div className="muted">Reported {friendlyDate(r.created_at)}</div>
              {/* Photos can be added until the repair is finished; after
                  that there is nothing left for them to inform. */}
              <RequestPhotos requestId={r.id}
                canAdd={r.status !== 'completed' && r.status !== 'closed'} />
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center', marginTop: '2rem' }}>
        <h2>Your lease</h2>
        <button className="link" onClick={() => setViewingLease(true)}>
          View lease
        </button>
      </div>
      {signing && !signing.landlord_signed && (
        <p className="muted">Waiting for your landlord to countersign.</p>
      )}
      <div className="card-list">
        <div>
          <strong>{money(Number(lease.rent_amount))}/month</strong>
          <div className="muted">
            Due on day {lease.rent_due_day} · {lease.status}
          </div>
          <div className="muted">
            {lease.start_date}{lease.end_date ? ` – ${lease.end_date}` : ' – ongoing'}
          </div>
          {Number(lease.deposit_amount) > 0 && (
            <div className="muted">
              Security deposit: {money(Number(lease.deposit_amount))}
            </div>
          )}
          {lease.fee_payer === 'tenant' && (
            <div className="muted">
              A payment processing fee is added at checkout when paying online.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** A payment on this charge that the bank has accepted but not yet cleared. */
function hasPaymentOnItsWay(c: ChargeWithPlace): boolean {
  return (c.payments ?? []).some((p) => p.status === 'pending' || p.status === 'processing')
}

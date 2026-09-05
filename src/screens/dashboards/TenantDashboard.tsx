import { useEffect, useState } from 'react'
import { supabase, describeError } from '../../lib/supabase'
import {
  fetchCharges, outstanding, totalOutstanding, isOverdue, money, chargeLabel,
  type ChargeWithPlace,
} from '../../lib/charges'
import { fetchRequests, type MaintenanceRequest } from '../../lib/maintenance'
import { RequestRepair } from '../RequestRepair'
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

  useEffect(() => {
    if (!supabase) return
    // No explicit filter — RLS already scopes both to this tenant.
    supabase
      .from('leases')
      .select('id, unit_id, rent_amount, status, start_date, end_date, rent_due_day, deposit_amount, fee_payer')
      .then(({ data, error }) => {
        if (error) setError(describeError(error))
        else setLeases(data as unknown as Lease[])
      })
    fetchCharges()
      .then(setCharges)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
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

  function loadRequests() {
    fetchRequests()
      .then(setRequests)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  function loadCharges() {
    fetchCharges()
      .then(setCharges)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
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
        onDone={() => {
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

  if (signing && !signing.tenant_signed) {
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
                  {isOverdue(c) ? 'Overdue' : c.status}
                </span>
              </div>
              <div className="muted">
                Due {c.due_date} · {money(Number(c.amount))}
                {Number(c.amount_paid) > 0 && ` · ${money(Number(c.amount_paid))} paid`}
                {outstanding(c) > 0 && ` · ${money(outstanding(c))} left`}
              </div>
              {stripeConfigured && outstanding(c) > 0 && (
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
        {!reporting && (
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
                <span className="muted" style={{ margin: 0 }}>{r.status}</span>
              </div>
              <div>{r.description}</div>
              <div className="muted">Reported {r.created_at.slice(0, 10)}</div>
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

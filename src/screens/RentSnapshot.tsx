import { useEffect, useState } from 'react'
import { errorMessage } from '../lib/supabase'
import {
  fetchRentTotals, periodRange, PERIOD_OPTIONS,
  type RentTotals, type PeriodKey,
} from '../lib/analytics'
import { money } from '../lib/charges'
import { navigate } from '../lib/route'

type Props = {
  organizationId: string
  propertyChoices?: { id: string; name: string }[]
  /** Home shows the four figures only; the Rent screen adds the controls. */
  showFilters?: boolean
}

/**
 * The financial snapshot: expected, collected, outstanding, collection rate.
 *
 * Four labelled figures rather than a sentence. "$0 collected of $2,280
 * billed" reads as prose and makes the reader pick the numbers back out of
 * it; the spec asks for four numbers because four numbers is what is being
 * asked.
 *
 * Expected comes from rent_totals(), which counts what the LEASES say is
 * due rather than what the billing job has written. Between the 1st of a
 * month and that job running there are no charge rows yet, and the figure
 * this replaced said $0 expected while every lease said otherwise.
 */
export function RentSnapshot({
  organizationId, propertyChoices = [], showFilters = false,
}: Props) {
  const [totals, setTotals] = useState<RentTotals | null>(null)
  const [period, setPeriod] = useState<PeriodKey>('this_month')
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [propertyId, setPropertyId] = useState('')
  const [error, setError] = useState<string | null>(null)

  const range = periodRange(period, custom)

  useEffect(() => {
    // A custom range with only one end filled in would query a span the
    // user has not finished describing.
    if (period === 'custom' && (!custom.from || !custom.to)) return
    setError(null)
    fetchRentTotals(organizationId, range, propertyId || null)
      .then(setTotals)
      .catch((e) => setError(errorMessage(e)))
  }, [organizationId, period, custom.from, custom.to, propertyId])

  if (error) return <p className="muted">The snapshot couldn't load. ({error})</p>
  if (!totals) return <p className="muted">Loading…</p>

  const rate = totals.expected > 0
    ? Math.round((totals.collected / totals.expected) * 100)
    : 100

  // Tapping any figure opens the rent screen, where the tenants and
  // transactions behind it are. On the rent screen itself there is nowhere
  // further to go, so they stop being buttons rather than pretending.
  const drill = showFilters ? undefined : () => navigate('/rent')

  return (
    <div className="card-list">
      <div>
        {showFilters && (
          <div className="filter-row">
            <select value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)}
                    aria-label="Reporting period">
              {PERIOD_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            {propertyChoices.length > 1 && (
              <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}
                      aria-label="Property">
                <option value="">All properties</option>
                {propertyChoices.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
          </div>
        )}

        {showFilters && period === 'custom' && (
          <div className="filter-row">
            <input type="date" value={custom.from} aria-label="From"
                   onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            <input type="date" value={custom.to} aria-label="To"
                   onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          </div>
        )}

        <div className="stat-grid">
          <Stat label="Rent expected" value={money(totals.expected)} onClick={drill} />
          <Stat label="Collected" value={money(totals.collected)} onClick={drill} />
          <Stat label="Outstanding" value={money(totals.outstanding)}
                emphasis={totals.outstanding > 0} onClick={drill} />
          <Stat label="Collection rate" value={`${rate}%`} onClick={drill} />
        </div>

        {/* Only when the two differ, and then said plainly — a landlord
            seeing "expected" exceed "billed" deserves to know why rather
            than wondering which number is wrong. */}
        {totals.expected > totals.billed && (
          <div className="muted" style={{ marginTop: '0.75rem' }}>
            {money(totals.expected - totals.billed)} of this hasn't been billed
            yet — rent is charged automatically on each lease's due day.
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({
  label, value, emphasis, onClick,
}: { label: string; value: string; emphasis?: boolean; onClick?: () => void }) {
  const body = (
    <>
      <div className="muted" style={{ fontSize: '0.8rem' }}>{label}</div>
      <div className={emphasis ? 'error-text' : undefined}
           style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>
        {value}
      </div>
    </>
  )

  if (!onClick) return <div className="stat">{body}</div>

  return (
    <div
      className="stat is-tappable"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
    >
      {body}
    </div>
  )
}

import { useEffect, useState } from 'react'
import {
  fetchRentSummary, monthLabel, collectionRate, type RentMonth,
} from '../lib/analytics'
import { money } from '../lib/charges'

type Props = { organizationId: string }

/**
 * How the business is doing: this month, and the last twelve.
 *
 * Deliberately does NOT show an overdue figure. RentStatus sits directly
 * below this and already computes one exactly, from each charge's own due
 * date; anything derived here from monthly buckets would be close but not
 * identical, and two overdue numbers disagreeing on one screen is worse
 * than one shown once.
 */
export function RentOverview({ organizationId }: Props) {
  const [months, setMonths] = useState<RentMonth[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchRentSummary(organizationId, 12)
      .then(setMonths)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [organizationId])

  if (error) return <p className="error-text">{error}</p>
  if (months === null) return <p className="muted">Loading…</p>

  const billedEver = months.reduce((s, m) => s + m.billed, 0)
  if (billedEver === 0) {
    return (
      <p className="empty-state">
        Nothing billed in the last year yet. Once a lease is running, rent
        is charged each month and this fills in.
      </p>
    )
  }

  const thisMonth = months[months.length - 1]
  const collectedYear = months.reduce((s, m) => s + m.collected, 0)

  return (
    <div className="card-list">
      <div>
        <ThisMonth month={thisMonth} />
        <TwelveMonths months={months} />
        <div className="muted" style={{ marginTop: '0.75rem' }}>
          Last 12 months: {money(collectedYear)} collected of {money(billedEver)} billed
          {' '}({Math.round((collectedYear / billedEver) * 100)}%)
        </div>
      </div>
    </div>
  )
}

function ThisMonth({ month }: { month: RentMonth }) {
  const rate = collectionRate(month)

  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'baseline', gap: '1rem' }}>
        <div>
          <div style={{ fontSize: '1.6rem', fontWeight: 600 }}>
            {money(month.collected)}
          </div>
          <div className="muted">
            collected of {money(month.billed)} billed this month
          </div>
        </div>
        <div style={{ fontSize: '1.2rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
          {Math.round(rate * 100)}%
        </div>
      </div>

      {/* A proportion bar, not a donut: it reads at a glance on a phone and
          needs no legend of its own. */}
      <div
        role="img"
        aria-label={`${Math.round(rate * 100)} percent of this month's rent collected`}
        style={{
          marginTop: '0.6rem', height: 10, borderRadius: 5,
          background: 'var(--line)', overflow: 'hidden',
        }}
      >
        <div style={{
          width: `${rate * 100}%`, height: '100%', borderRadius: 5,
          background: 'var(--series-collected)',
        }} />
      </div>
      {month.outstanding > 0 && (
        <div className="muted" style={{ marginTop: '0.4rem' }}>
          {money(month.outstanding)} still to come in
        </div>
      )}
    </div>
  )
}

// Chart geometry. A viewBox plus width:100% means one set of numbers works
// from a 320px phone to a desktop column.
const W = 360
const H = 150
const PLOT_TOP = 8
const PLOT_BOTTOM = 118
const BAR_W = 16
const SEGMENT_GAP = 2

/** A rect with only its top corners rounded — the data end, per the mark spec. */
function topRoundedPath(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, h, w / 2)
  return `M${x},${y + h} L${x},${y + radius} Q${x},${y} ${x + radius},${y}`
    + ` L${x + w - radius},${y} Q${x + w},${y} ${x + w},${y + radius}`
    + ` L${x + w},${y + h} Z`
}

function TwelveMonths({ months }: { months: RentMonth[] }) {
  const [selected, setSelected] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)

  const max = Math.max(...months.map((m) => m.billed), 1)
  const slotW = W / months.length
  const scale = (v: number) => (v / max) * (PLOT_BOTTOM - PLOT_TOP)

  const shown = selected != null ? months[selected] : null

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'baseline', gap: '1rem' }}>
        <strong>Rent by month</strong>
        <button className="link" style={{ margin: 0 }}
                onClick={() => setAsTable((t) => !t)}>
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>

      {/* Identity is never colour alone: a legend for the two series, and
          the table view below carries the same numbers without colour. */}
      <div style={{ display: 'flex', gap: '1rem', margin: '0.5rem 0' }}>
        <Key colour="var(--series-collected)" label="Collected" />
        <Key colour="var(--series-outstanding)" label="Outstanding" />
      </div>

      {asTable ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
            <thead>
              <tr>
                <th style={cell('left')}>Month</th>
                <th style={cell()}>Billed</th>
                <th style={cell()}>Collected</th>
                <th style={cell()}>Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}>
                  <td style={cell('left')}>{monthLabel(m.month, true)}</td>
                  <td style={cell()}>{money(m.billed)}</td>
                  <td style={cell()}>{money(m.collected)}</td>
                  <td style={cell()}>{m.outstanding > 0 ? money(m.outstanding) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            role="img"
            aria-label={`Rent billed and collected over the last ${months.length} months`}
            style={{ display: 'block', overflow: 'visible' }}
          >
            {/* Recessive baseline. No gridlines: at this size they compete
                with the marks rather than helping read them. */}
            <line x1={0} y1={PLOT_BOTTOM} x2={W} y2={PLOT_BOTTOM}
                  stroke="var(--line)" strokeWidth={1} />

            {months.map((m, i) => {
              const cx = i * slotW + slotW / 2
              const x = cx - BAR_W / 2
              const collectedH = scale(m.collected)
              const outstandingH = scale(m.outstanding)
              const isLast = i === months.length - 1
              const isSelected = selected === i

              // Collected sits on the baseline; what is still owed stacks
              // above it, so the bar's full height is what was billed.
              const collectedY = PLOT_BOTTOM - collectedH
              const outstandingY = collectedY - SEGMENT_GAP - outstandingH

              return (
                <g key={m.month}>
                  {outstandingH > 0.5 && (
                    <path
                      d={topRoundedPath(x, outstandingY, BAR_W, outstandingH, 4)}
                      fill="var(--series-outstanding)"
                    />
                  )}
                  {collectedH > 0.5 && (
                    <path
                      d={topRoundedPath(
                        x,
                        collectedY,
                        BAR_W,
                        collectedH,
                        outstandingH > 0.5 ? 0 : 4,
                      )}
                      fill="var(--series-collected)"
                    />
                  )}

                  {/* Full-height hit target, comfortably bigger than the
                      mark — a 16px bar is a poor thing to tap at. */}
                  <rect
                    x={cx - slotW / 2} y={0} width={slotW} height={PLOT_BOTTOM}
                    fill="transparent"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSelected(isSelected ? null : i)}
                  >
                    <title>
                      {`${monthLabel(m.month, true)}: ${money(m.collected)} collected of ${money(m.billed)} billed`}
                    </title>
                  </rect>

                  {/* Sparse labels — every third month plus the current one.
                      Twelve labels at this width collide. */}
                  {(i % 3 === 0 || isLast) && (
                    <text
                      x={cx} y={PLOT_BOTTOM + 14} textAnchor="middle"
                      fontSize={10} fill="var(--muted)"
                    >
                      {monthLabel(m.month)}
                    </text>
                  )}
                  {isSelected && (
                    <line x1={cx} y1={PLOT_TOP} x2={cx} y2={PLOT_BOTTOM}
                          stroke="var(--muted)" strokeWidth={1} strokeDasharray="2 2" />
                  )}
                </g>
              )
            })}
          </svg>

          {/* The detail a hover tooltip gives on a desktop, in a place a
              thumb can reach. */}
          <div className="muted" style={{ minHeight: '1.5em', marginTop: '0.25rem' }}>
            {shown
              ? `${monthLabel(shown.month, true)}: ${money(shown.collected)} collected`
                + ` of ${money(shown.billed)} billed`
                + (shown.outstanding > 0 ? ` · ${money(shown.outstanding)} outstanding` : '')
              : 'Tap a month for its figures.'}
          </div>
        </>
      )}
    </div>
  )
}

function Key({ colour, label }: { colour: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: colour }} />
      {/* Label in text ink, never the series colour. */}
      <span className="muted" style={{ margin: 0 }}>{label}</span>
    </span>
  )
}

/** Money right-aligns so digits line up down the column; the month label doesn't. */
function cell(align: 'left' | 'right' = 'right'): React.CSSProperties {
  return {
    textAlign: align,
    padding: '0.3rem 0.5rem',
    borderBottom: '1px solid var(--line)',
    whiteSpace: 'nowrap',
  }
}

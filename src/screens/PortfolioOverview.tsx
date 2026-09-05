import { type DashboardSummary, type PropertyRow } from '../lib/dashboard'
import { money } from '../lib/charges'

type Props = {
  summary: DashboardSummary
  onOpenProperty: (id: string) => void
  onViewMaintenance: () => void
}

/**
 * The portfolio at a glance: what is let, what it earns, and where the
 * problems are.
 *
 * Occupancy is derived from active leases. units.status exists and looks
 * like the obvious source, but nothing has ever written to it — it reads
 * 'vacant' for every unit ever created, whoever is living there.
 */
export function PortfolioOverview({ summary, onOpenProperty, onViewMaintenance }: Props) {
  const { portfolio, properties, maintenance } = summary

  if (portfolio.properties === 0) {
    return (
      <p className="empty-state">
        No properties yet. Add one and its units, and this fills in.
      </p>
    )
  }

  return (
    <div>
      {/* The roll-up only earns its place once there is something to roll
          up. With one property it repeats the single row below it word for
          word, which is how a summary becomes noise. */}
      {portfolio.properties > 1 && (
        <div className="card-list">
          <div>
            <strong>
              {portfolio.properties} properties · {portfolio.units}{' '}
              {portfolio.units === 1 ? 'unit' : 'units'}
            </strong>
            <div className="muted">
              {portfolio.occupied} occupied · {portfolio.vacant} vacant
              {portfolio.monthly_rent > 0
                && ` · ${money(Number(portfolio.monthly_rent))}/month in rent`}
            </div>
          </div>
        </div>
      )}

      <div className="card-list">
        {properties.map((p) => (
          <PropertyLine key={p.id} property={p} onClick={() => onOpenProperty(p.id)} />
        ))}
      </div>

      {/* Only when there is something to say. The working lists further
          down already announce themselves when empty; a third box saying
          "no repairs" above two more saying the same thing was most of
          what made this page feel long. */}
      {(maintenance.open > 0 || maintenance.scheduled > 0) && (
        <>
          <h3 style={{ marginTop: '2rem', marginBottom: '0.5rem' }}>Maintenance</h3>
          <div className="card-list">
            <div
              role="button"
              tabIndex={0}
              onClick={onViewMaintenance}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onViewMaintenance() }
              }}
              style={{ cursor: 'pointer' }}
            >
              <strong>
                {maintenance.open} open
                {maintenance.urgent > 0 && ` · ${maintenance.urgent} high priority`}
              </strong>
              <div className="muted">
                {maintenance.unassigned > 0 && `${maintenance.unassigned} not yet assigned · `}
                {maintenance.scheduled} scheduled
                {' · '}{maintenance.completed_this_month} finished this month
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function PropertyLine({ property, onClick }: { property: PropertyRow; onClick: () => void }) {
  const overdue = Number(property.overdue)

  // Red for money already late or an urgent repair, amber for anything else
  // wanting a look, otherwise green. Stated in words underneath too — a dot
  // on its own is unreadable to a colour-blind reader and meaningless to a
  // screen reader.
  const status = overdue > 0 || property.urgent_maintenance > 0 ? 'urgent'
    : property.open_maintenance > 0 || property.vacant > 0 ? 'attention'
      : 'fine'

  const COLOUR = {
    urgent: 'var(--danger)',
    attention: 'var(--series-outstanding)',
    fine: 'var(--series-collected)',
  } as const

  const notes: string[] = []
  if (overdue > 0) notes.push(`${money(overdue)} overdue`)
  if (property.urgent_maintenance > 0) notes.push(`${property.urgent_maintenance} urgent repair(s)`)
  else if (property.open_maintenance > 0) notes.push(`${property.open_maintenance} open repair(s)`)
  if (property.vacant > 0) notes.push(`${property.vacant} vacant`)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      style={{ cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'baseline', gap: '1rem' }}>
        <span style={{ display: 'flex', gap: '0.6rem', alignItems: 'baseline' }}>
          <span aria-hidden="true" style={{
            width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
            background: COLOUR[status],
          }} />
          <strong>{property.name}</strong>
        </span>
        <span className="muted" style={{ margin: 0, whiteSpace: 'nowrap' }}>
          {property.occupied}/{property.units} let
        </span>
      </div>
      <div className="muted" style={{ marginLeft: '1.5rem' }}>
        {notes.length > 0 ? notes.join(' · ') : 'Nothing outstanding'}
      </div>
    </div>
  )
}

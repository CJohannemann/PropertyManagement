import { useEffect, useState } from 'react'
import { errorMessage } from '../lib/supabase'
import { fetchDashboard, type DashboardSummary } from '../lib/dashboard'
import { navigate } from '../lib/route'
import { NeedsAttention } from './NeedsAttention'
import { PortfolioOverview } from './PortfolioOverview'

type Props = {
  organizationId: string
  onOpenProperty: (id: string) => void
}

/**
 * The action centre and the portfolio snapshot, sharing one request.
 *
 * Both read from dashboard_summary(), so they are fetched together rather
 * than twice — this is the first thing loaded and usually on a phone.
 *
 * "View" actions navigate to a real screen with its own URL, so the back
 * button returns here and a link to a balance can be shared.
 */
export function DashboardSections({ organizationId, onOpenProperty }: Props) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchDashboard(organizationId)
      .then(setSummary)
      .catch((e) => setError(errorMessage(e)))
  }, [organizationId])

  if (error) {
    return (
      <p className="muted">
        This summary couldn't load, though everything below is current. ({error})
      </p>
    )
  }
  if (!summary) return <p className="muted">Loading…</p>

  return (
    <>
      <NeedsAttention
        summary={summary}
        onViewRent={() => navigate('/rent')}
        onViewMaintenance={() => navigate('/maintenance')}
      />

      <h2 style={{ marginTop: '2rem' }}>Your portfolio</h2>
      <PortfolioOverview
        summary={summary}
        onOpenProperty={onOpenProperty}
        onViewMaintenance={() => navigate('/maintenance')}
      />
    </>
  )
}

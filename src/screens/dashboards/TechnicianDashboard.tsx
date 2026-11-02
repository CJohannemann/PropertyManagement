import { errorMessage } from '../../lib/supabase'
import { useEffect, useState } from 'react'
import { fetchJobs, type Job } from '../../lib/maintenance'
import { JobDetail } from '../JobDetail'
import { TechnicianProperties } from '../TechnicianProperties'
import type { Route } from '../../lib/route'

type Props = {
  memberId: string
  section: Route
  propertyId?: string
}

export function TechnicianDashboard({ memberId, section, propertyId }: Props) {
  if (section === '/properties') {
    return <TechnicianProperties memberId={memberId} propertyId={propertyId} />
  }
  return <TechnicianJobs memberId={memberId} />
}

function TechnicianJobs({ memberId }: { memberId: string }) {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [selected, setSelected] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const rows = await fetchJobs()
      setJobs(rows)
      // Keeps the open job's own status/date current after an edit,
      // instead of showing a stale copy until you navigate away.
      if (selected) setSelected(rows.find((j) => j.id === selected.id) ?? null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  useEffect(() => { load() }, [])

  if (selected) {
    return (
      <JobDetail
        job={selected}
        memberId={memberId}
        canEdit
        onBack={() => { setSelected(null); load() }}
        onChanged={load}
      />
    )
  }

  // Assigned jobs are simply theirs (034) — there is no offer to answer,
  // so everything assigned and not finished is one list. 'offered' is
  // included only for a job caught mid-change before 034 ran.
  const open = jobs?.filter(
    (j) => j.status === 'scheduled' || j.status === 'in_progress'
      || j.status === 'offered') ?? []
  const done = jobs?.filter((j) => j.status === 'completed') ?? []

  return (
    <div>
      <h2>Your jobs</h2>
      {error && <p className="error-text">{error}</p>}
      {jobs === null && !error && <p className="muted">Loading…</p>}
      {jobs?.length === 0 && (
        <p className="empty-state">
          Nothing assigned to you yet. Jobs appear here once a manager
          assigns one to you.
        </p>
      )}

      {open.length > 0 && (
        <div className="card-list">
          {open.map((j) => <JobRow key={j.id} job={j} onOpen={() => setSelected(j)} />)}
        </div>
      )}
      {/* Only when there is something above to explain the emptiness —
          otherwise the general empty state further up already covers it. */}
      {open.length === 0 && done.length > 0 && (
        <p className="empty-state">Nothing open right now.</p>
      )}

      {done.length > 0 && (
        <>
          <h3 style={{ marginTop: '2rem' }}>Completed</h3>
          <div className="card-list">
            {done.map((j) => <JobRow key={j.id} job={j} onOpen={() => setSelected(j)} />)}
          </div>
        </>
      )}
    </div>
  )
}

function JobRow({ job, onOpen }: { job: Job; onOpen: () => void }) {
  return (
    <div onClick={onOpen} style={{ cursor: 'pointer' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <strong>
          {job.properties?.name}{job.units?.label ? ` · ${job.units.label}` : ''}
        </strong>
        <span className="muted" style={{ margin: 0 }}>{job.status}</span>
      </div>
      {job.notes && <div className="muted">{job.notes}</div>}
      {job.scheduled_date && (
        <div className="muted">Scheduled {job.scheduled_date}</div>
      )}
    </div>
  )
}

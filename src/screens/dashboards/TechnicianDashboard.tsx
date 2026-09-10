import { errorMessage } from '../../lib/supabase'
import { useEffect, useState } from 'react'
import { fetchJobs, type Job } from '../../lib/maintenance'
import { JobDetail } from '../JobDetail'

type Props = { memberId: string }

export function TechnicianDashboard({ memberId }: Props) {
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

  // Offers first and separately: they are the only rows that need an
  // answer, and burying them in a list of work already accepted is how an
  // offer sits unanswered for three days.
  const offered = jobs?.filter((j) => j.status === 'offered') ?? []
  const open = jobs?.filter(
    (j) => j.status === 'scheduled' || j.status === 'in_progress') ?? []
  const done = jobs?.filter((j) => j.status === 'completed') ?? []

  return (
    <div>
      {offered.length > 0 && (
        <>
          <h2>Waiting for your answer</h2>
          <div className="card-list">
            {offered.map((j) => (
              <JobRow key={j.id} job={j} onOpen={() => setSelected(j)} />
            ))}
          </div>
        </>
      )}

      <h2 style={{ marginTop: offered.length > 0 ? '2rem' : undefined }}>
        Your jobs
      </h2>
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
      {open.length === 0 && offered.length > 0 && (
        <p className="empty-state">Nothing accepted yet.</p>
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

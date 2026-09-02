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
      setError(e instanceof Error ? e.message : String(e))
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

  const open = jobs?.filter((j) => j.status !== 'completed' && j.status !== 'canceled') ?? []
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

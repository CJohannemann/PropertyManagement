import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '../lib/supabase'
import { listRequestPhotos, requestPhotoUrl, uploadRequestPhoto } from '../lib/maintenance'

/**
 * Thumbnails for whatever was photographed of a reported problem, and —
 * with `canAdd` — a way to add more after the request was sent. A tenant
 * often only thinks to photograph it later, or the problem gets worse.
 * Storage RLS (015) already lets a tenant on the unit's lease add to the
 * request; this is just the button for it.
 */
export function RequestPhotos({ requestId, canAdd = false }: {
  requestId: string
  canAdd?: boolean
}) {
  const [paths, setPaths] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  function load() {
    listRequestPhotos(requestId).then(setPaths).catch(() => setPaths([]))
  }
  useEffect(load, [requestId])

  return (
    <>
      {paths.length > 0 && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
          {paths.map((p) => <RequestPhoto key={p} path={p} />)}
        </div>
      )}
      {canAdd && (
        <div style={{ marginTop: '0.5rem' }}>
          {/* The file input is hidden behind a link-style button: "Choose
              File · no file selected" is a lot of screen for an occasional
              action. */}
          <button type="button" className="link" disabled={busy}
            onClick={() => input.current?.click()}>
            {busy ? 'Uploading…' : '+ Add a photo'}
          </button>
          <input
            ref={input}
            type="file"
            // No `capture`, same as when reporting: the gallery has to be
            // reachable, not just the camera.
            accept="image/*"
            multiple
            disabled={busy}
            style={{ display: 'none' }}
            onChange={async (e) => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              if (!files.length) return
              setBusy(true); setError(null)
              try {
                for (const f of files) await uploadRequestPhoto(requestId, f)
              } catch (err) {
                setError(errorMessage(err))
              }
              setBusy(false)
              load()
            }}
          />
          {error && <p className="error-text">{error}</p>}
        </div>
      )}
    </>
  )
}

function RequestPhoto({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null)
  // Signed on demand, same reasoning as receipts: the bucket is private
  // and a signed link should not be minted for photos nobody opens.
  useEffect(() => { requestPhotoUrl(path).then(setUrl).catch(() => setUrl(null)) }, [path])
  if (!url) return null
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt="Reported problem" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6 }} />
    </a>
  )
}

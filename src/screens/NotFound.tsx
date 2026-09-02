import { navigate } from '../lib/route'

export function NotFound() {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Page not found</h1>
        <button className="primary" onClick={() => navigate('/')}>
          Go home
        </button>
      </div>
    </div>
  )
}

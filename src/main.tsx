import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './App.css'
import App from './App.tsx'
import { ErrorBoundary } from './screens/ErrorBoundary.tsx'
import { pushSupported, registerServiceWorker } from './lib/push'

/**
 * Stops the scroll wheel from changing a focused number field. Hiding the
 * spinner buttons in index.css doesn't cover this: scrolling the page with
 * the cursor over a focused rent or mileage input silently edits the
 * value, and a rent figure that's wrong by one is the kind of error nobody
 * notices until a tenant queries their balance.
 *
 * Blurs rather than preventing the event, so the page still scrolls
 * normally — the field just stops listening. Passive, so it never delays
 * scrolling.
 */
document.addEventListener(
  'wheel',
  () => {
    const el = document.activeElement
    if (el instanceof HTMLInputElement && el.type === 'number') el.blur()
  },
  { passive: true },
)

// Registered up front, not on the first tap of "Turn on alerts": push can
// only subscribe through an active worker, and installing one takes a
// moment. Failure is harmless here — enabling alerts registers it again
// and reports the error then.
if (pushSupported) registerServiceWorker().catch(() => {})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

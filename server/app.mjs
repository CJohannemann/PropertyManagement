// The payments API as an Express app, without a listening socket — so
// server/index.mjs can serve it and server/test/api.test.mjs can drive it
// on a throwaway port.

import express from 'express'
import { isLiveMode } from './config.mjs'
import { HttpError } from './auth.mjs'
import { connectRouter } from './routes/connect.mjs'
import { paymentsRouter } from './routes/payments.mjs'
import { webhookRouter } from './routes/webhook.mjs'

export const app = express()
app.disable('x-powered-by')

// Mounted BEFORE the JSON parser, deliberately. Stripe signs the raw
// request bytes; parsing them into an object first and re-serialising
// produces different bytes and every signature check fails. This ordering
// is load-bearing, not stylistic.
app.use('/api/stripe/webhook', webhookRouter)

app.use(express.json({ limit: '64kb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mode: isLiveMode ? 'live' : 'test' })
})

app.use('/api/connect', connectRouter)
app.use('/api/payments', paymentsRouter)

// Express 5 forwards rejected promises here on its own, so route handlers
// need no try/catch of their own.
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message })
  }

  // A Stripe error can carry the request payload; log the message only.
  console.error('[api] unhandled error:', err.message)

  // Nothing internal goes back to the browser. A tenant seeing a Postgres
  // constraint name learns nothing useful and an attacker learns the
  // schema.
  res.status(500).json({ error: 'Something went wrong on our end.' })
})

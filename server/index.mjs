#!/usr/bin/env node
//
// The payments API. The first application server in this project —
// everything else the browser needs it gets from PostgREST directly, under
// row-level security. Stripe cannot work that way: the secret key must
// never reach a browser, and webhooks need somewhere to land.
//
// Runs behind nginx, which routes /api/ here. Binds to localhost only, the
// same as every other service in this stack.
//
//   node server/index.mjs

import express from 'express'
import { config, isLiveMode } from './config.mjs'
import { HttpError } from './auth.mjs'
import { connectRouter } from './routes/connect.mjs'
import { paymentsRouter } from './routes/payments.mjs'
import { webhookRouter } from './routes/webhook.mjs'
import { close as closeDb } from './db.mjs'

const app = express()
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

const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(
    `[api] listening on 127.0.0.1:${config.port} in ${isLiveMode ? 'LIVE' : 'test'} mode`,
  )
  if (isLiveMode) {
    console.log('[api] LIVE MODE — payments here move real money.')
  }
})

// systemd sends SIGTERM on stop and restart. Finish in-flight requests
// rather than dropping a payment mid-write.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[api] ${signal} — shutting down`)
    server.close(async () => {
      await closeDb()
      process.exit(0)
    })
  })
}

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

import { config, isLiveMode } from './config.mjs'
import { app } from './app.mjs'
import { close as closeDb } from './db.mjs'

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

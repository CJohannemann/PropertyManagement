// Postgres access for the API service.
//
// This connects as `postgres`, which bypasses row-level security — the
// same thing deploy/create-test-user.sh does, and the reason
// db/schema.sql's payments policies deliberately give the client no way to
// write a payment. That makes every query here security-critical: RLS is
// not a backstop on this connection, so authority must be checked in SQL,
// explicitly, on every request.
//
// Nothing in this file interpolates a value into SQL. Parameters only.

import pg from 'pg'
import { config } from './config.mjs'

// numeric/decimal comes back from pg as a string by default, which is
// correct — parsing money through a float is how rounding errors get into
// a ledger. Kept as strings and handled in cents at the edges.
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 })

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message)
})

export function query(text, params) {
  return pool.query(text, params)
}

/** Runs fn inside a transaction, rolling back if it throws. */
export async function transaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

export async function close() {
  await pool.end()
}

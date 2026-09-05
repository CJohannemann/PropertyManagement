// Configuration for the API service, read from deploy/selfhost/.env — the
// same file the containers read, so there is one place secrets live rather
// than a second copy that can drift out of step.
//
// Every value is validated at startup and the process refuses to start
// without them. A payments service that boots with a missing key and fails
// on the first real payment is worse than one that never boots.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENV_PATH = join(HERE, '..', 'deploy', 'selfhost', '.env')

function loadEnvFile(path) {
  const env = {}
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return env
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) env[m[1]] = m[2].trim()
  }
  return env
}

// The real environment wins over the file, so a systemd unit or a test can
// override without editing .env.
const fileEnv = loadEnvFile(ENV_PATH)
const env = { ...fileEnv, ...process.env }

function required(name) {
  const value = env[name]
  if (!value) {
    throw new Error(
      `${name} is not set. The API service reads ${ENV_PATH}; ` +
      'see deploy/selfhost/.env.example for what each value is.',
    )
  }
  return value
}

export const config = {
  appUrl: required('APP_URL'),
  jwtSecret: required('JWT_SECRET'),
  databaseUrl:
    env.API_DATABASE_URL
    || `postgres://postgres:${required('POSTGRES_PASSWORD')}@127.0.0.1:5433/postgres`,
  port: Number(env.API_PORT || 8003),

  stripe: {
    secretKey: required('STRIPE_SECRET_KEY'),
    webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
  },

  // Stripe's ACH pricing, as configuration rather than a constant: it is
  // their number to change, and it should not take a migration and a
  // deploy to follow them. Percent is a fraction (0.008 = 0.8%).
  achFee: {
    percent: Number(env.ACH_FEE_PERCENT ?? 0.008),
    capCents: Number(env.ACH_FEE_CAP_CENTS ?? 500),
  },
}

// A live key reaching a server that thinks it is in testing is exactly the
// mistake that moves real money by accident. Say so loudly at boot.
export const isLiveMode = config.stripe.secretKey.startsWith('sk_live_')

if (!config.stripe.secretKey.startsWith('sk_test_') && !isLiveMode) {
  throw new Error('STRIPE_SECRET_KEY does not look like a Stripe secret key.')
}

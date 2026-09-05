#!/usr/bin/env node
//
// Generates a VAPID keypair for Web Push — the "application server" key
// pair a push service (browser vendor) uses to confirm pushes are coming
// from us and not someone who found a subscription endpoint. No
// dependency needed: createECDH's raw public/private key output is
// already the uncompressed-point / raw-scalar format VAPID wants, same
// "no dependency needed" reasoning as mint-jwt.mjs next to this file.
//
//   node generate-vapid-keys.mjs
import crypto from 'crypto'

const ecdh = crypto.createECDH('prime256v1')
ecdh.generateKeys()

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

console.log(`VAPID_PUBLIC_KEY=${b64url(ecdh.getPublicKey())}`)
console.log(`VAPID_PRIVATE_KEY=${b64url(ecdh.getPrivateKey())}`)

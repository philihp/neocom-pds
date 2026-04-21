import * as crypto from 'node:crypto'

// AES-256-GCM envelope. Layout:
//   [ 12 bytes nonce ][ 16 bytes auth tag ][ ciphertext ]
// Stored as a single base64 string in the DB.
//
// Rotating the key invalidates every stored ciphertext (all users must
// re-auth via EVE SSO). We don't implement key rotation / re-encryption
// because the threat model here is "DB leaks, key does not" - key-rotation
// schemes add complexity that the v1 doesn't need.

const ALGO = 'aes-256-gcm'
const NONCE_LEN = 12
const TAG_LEN = 16

export const encryptToken = (key: Buffer, plaintext: string): string => {
  const nonce = crypto.randomBytes(NONCE_LEN)
  const cipher = crypto.createCipheriv(ALGO, key, nonce)
  const ct = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, tag, ct]).toString('base64')
}

export const decryptToken = (key: Buffer, envelope: string): string => {
  const buf = Buffer.from(envelope, 'base64')
  if (buf.length < NONCE_LEN + TAG_LEN) {
    throw new Error('Ciphertext too short')
  }
  const nonce = buf.subarray(0, NONCE_LEN)
  const tag = buf.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN)
  const ct = buf.subarray(NONCE_LEN + TAG_LEN)
  const decipher = crypto.createDecipheriv(ALGO, key, nonce)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return pt.toString('utf8')
}

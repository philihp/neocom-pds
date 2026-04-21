import Database from 'better-sqlite3'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { encryptToken, decryptToken } from './crypto.js'

export interface StoredTokens {
  readonly characterId: number
  readonly accessToken: string
  readonly refreshToken: string
  readonly accessExpiresAt: number // unix ms
  readonly scopes: ReadonlyArray<string>
  readonly invalidatedAt: number | null // non-null = refresh failed, don't use
}

export interface TokenStore {
  readonly upsert: (t: StoredTokens) => void
  readonly get: (characterId: number) => StoredTokens | null
  readonly markInvalid: (characterId: number, reason: string) => void
  readonly close: () => void
}

interface TokenRow {
  character_id: number
  access_ct: string
  refresh_ct: string
  access_expires_at: number
  scopes: string
  invalidated_at: number | null
  invalidated_reason: string | null
}

export const openTokenStore = (
  dataDir: string,
  encryptionKey: Buffer,
): TokenStore => {
  fs.mkdirSync(dataDir, { recursive: true })
  const db = new Database(path.join(dataDir, 'eve-tokens.sqlite'))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS eve_token (
      character_id       INTEGER PRIMARY KEY,
      access_ct          TEXT    NOT NULL,
      refresh_ct         TEXT    NOT NULL,
      access_expires_at  INTEGER NOT NULL,
      scopes             TEXT    NOT NULL,
      invalidated_at     INTEGER,
      invalidated_reason TEXT,
      updated_at         INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `)

  const upsertStmt = db.prepare(`
    INSERT INTO eve_token
      (character_id, access_ct, refresh_ct, access_expires_at, scopes,
       invalidated_at, invalidated_reason, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, unixepoch() * 1000)
    ON CONFLICT(character_id) DO UPDATE SET
      access_ct          = excluded.access_ct,
      refresh_ct         = excluded.refresh_ct,
      access_expires_at  = excluded.access_expires_at,
      scopes             = excluded.scopes,
      invalidated_at     = NULL,
      invalidated_reason = NULL,
      updated_at         = unixepoch() * 1000
  `)
  const getStmt = db.prepare(
    `SELECT * FROM eve_token WHERE character_id = ?`,
  )
  const invalidateStmt = db.prepare(`
    UPDATE eve_token
       SET invalidated_at = unixepoch() * 1000,
           invalidated_reason = ?
     WHERE character_id = ?
  `)

  const rowToTokens = (row: TokenRow): StoredTokens => ({
    characterId: row.character_id,
    accessToken: decryptToken(encryptionKey, row.access_ct),
    refreshToken: decryptToken(encryptionKey, row.refresh_ct),
    accessExpiresAt: row.access_expires_at,
    scopes: row.scopes === '' ? [] : row.scopes.split(' '),
    invalidatedAt: row.invalidated_at,
  })

  return {
    upsert: (t) => {
      upsertStmt.run(
        t.characterId,
        encryptToken(encryptionKey, t.accessToken),
        encryptToken(encryptionKey, t.refreshToken),
        t.accessExpiresAt,
        t.scopes.join(' '),
      )
    },
    get: (id) => {
      const row = getStmt.get(id) as TokenRow | undefined
      return row ? rowToTokens(row) : null
    },
    markInvalid: (id, reason) => {
      invalidateStmt.run(reason, id)
    },
    close: () => db.close(),
  }
}

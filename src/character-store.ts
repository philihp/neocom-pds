import Database from 'better-sqlite3'
import * as path from 'node:path'
import * as fs from 'node:fs'

// We keep this in a separate sqlite file alongside the PDS's data directory.
// We intentionally don't touch the PDS's own account db - we just maintain
// the mapping from EVE character -> atproto DID on our side.

export interface CharacterMapping {
  readonly characterId: number
  readonly did: string
  readonly handle: string
  readonly owner: string // EVE owner hash - detects character transfers
  readonly createdAt: string
}

export interface CharacterStore {
  readonly findByCharacterId: (id: number) => CharacterMapping | null
  readonly findByDid: (did: string) => CharacterMapping | null
  readonly insert: (m: Omit<CharacterMapping, 'createdAt'>) => void
  readonly updateOwner: (id: number, owner: string) => void
  readonly close: () => void
}

export const openCharacterStore = (dataDir: string): CharacterStore => {
  fs.mkdirSync(dataDir, { recursive: true })
  const db = new Database(path.join(dataDir, 'eve-characters.sqlite'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS character_account (
      character_id INTEGER PRIMARY KEY,
      did          TEXT NOT NULL UNIQUE,
      handle       TEXT NOT NULL,
      owner        TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const findByIdStmt = db.prepare(
    `SELECT character_id as characterId, did, handle, owner, created_at as createdAt
     FROM character_account WHERE character_id = ?`,
  )
  const findByDidStmt = db.prepare(
    `SELECT character_id as characterId, did, handle, owner, created_at as createdAt
     FROM character_account WHERE did = ?`,
  )
  const insertStmt = db.prepare(
    `INSERT INTO character_account (character_id, did, handle, owner)
     VALUES (?, ?, ?, ?)`,
  )
  const updateOwnerStmt = db.prepare(
    `UPDATE character_account SET owner = ? WHERE character_id = ?`,
  )

  return {
    findByCharacterId: (id) =>
      (findByIdStmt.get(id) as CharacterMapping | undefined) ?? null,
    findByDid: (did) =>
      (findByDidStmt.get(did) as CharacterMapping | undefined) ?? null,
    insert: ({ characterId, did, handle, owner }) => {
      insertStmt.run(characterId, did, handle, owner)
    },
    updateOwner: (id, owner) => {
      updateOwnerStmt.run(owner, id)
    },
    close: () => db.close(),
  }
}

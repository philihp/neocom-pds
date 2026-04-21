import Database from 'better-sqlite3'
import * as path from 'node:path'
import * as fs from 'node:fs'

export interface UserCharacterBinding {
  readonly supabaseUserId: string
  readonly characterId: number
  readonly boundAt: string
}

export interface UserStore {
  readonly findByUserId: (userId: string) => UserCharacterBinding | null
  readonly findByCharacterId: (characterId: number) => UserCharacterBinding | null
  readonly bind: (userId: string, characterId: number) => void
  readonly close: () => void
}

export const openUserStore = (dataDir: string): UserStore => {
  fs.mkdirSync(dataDir, { recursive: true })
  const db = new Database(path.join(dataDir, 'users.sqlite'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_character_binding (
      supabase_user_id TEXT PRIMARY KEY,
      character_id     INTEGER NOT NULL UNIQUE,
      bound_at         TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const findByUserStmt = db.prepare(
    `SELECT supabase_user_id as supabaseUserId, character_id as characterId, bound_at as boundAt
     FROM user_character_binding WHERE supabase_user_id = ?`,
  )
  const findByCharacterStmt = db.prepare(
    `SELECT supabase_user_id as supabaseUserId, character_id as characterId, bound_at as boundAt
     FROM user_character_binding WHERE character_id = ?`,
  )
  const bindStmt = db.prepare(
    `INSERT OR REPLACE INTO user_character_binding (supabase_user_id, character_id)
     VALUES (?, ?)`,
  )

  return {
    findByUserId: (userId) =>
      (findByUserStmt.get(userId) as UserCharacterBinding | undefined) ?? null,
    findByCharacterId: (characterId) =>
      (findByCharacterStmt.get(characterId) as UserCharacterBinding | undefined) ?? null,
    bind: (userId, characterId) => {
      bindStmt.run(userId, characterId)
    },
    close: () => db.close(),
  }
}

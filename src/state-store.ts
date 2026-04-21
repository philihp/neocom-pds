import * as R from 'ramda'

export interface OAuthStateRecord {
  readonly codeVerifier: string
  readonly supabaseUserId: string
  readonly createdAt: number
}

const TTL_MS = 10 * 60 * 1000 // 10 minutes

export interface StateStore {
  readonly put: (state: string, codeVerifier: string, supabaseUserId: string) => void
  readonly take: (state: string) => OAuthStateRecord | null
  readonly size: () => number
}

const isExpired = (now: number) => (r: OAuthStateRecord): boolean =>
  now - r.createdAt > TTL_MS

export const createStateStore = (): StateStore => {
  const store = new Map<string, OAuthStateRecord>()

  const prune = (): void => {
    const now = Date.now()
    const expiredKeys = R.pipe(
      () => Array.from(store.entries()),
      R.filter(([, rec]: [string, OAuthStateRecord]) => isExpired(now)(rec)),
      R.map(R.head) as (pairs: Array<[string, OAuthStateRecord]>) => string[],
    )()
    expiredKeys.forEach((k) => store.delete(k))
  }

  return {
    put: (state, codeVerifier, supabaseUserId) => {
      prune()
      store.set(state, { codeVerifier, supabaseUserId, createdAt: Date.now() })
    },
    take: (state) => {
      prune()
      const rec = store.get(state)
      if (!rec) return null
      store.delete(state)
      return rec
    },
    size: () => store.size,
  }
}

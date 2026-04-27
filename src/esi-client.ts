import * as R from 'ramda'
import type { EveConfig } from './config.js'
import type { TokenStore, StoredTokens } from './token-store.js'
import {
  refreshAccessToken,
  TokenRefreshError,
  verifyAccessToken,
} from './eve-sso.js'

const ESI_BASE = 'https://esi.evetech.net/latest'
const ACCESS_TOKEN_SLACK_MS = 30_000 // refresh when <30s remaining

// --- Error-limit tracking -------------------------------------------------
// ESI is per-IP, so a single shared state here is correct for the whole
// process. When the remaining count gets low, we refuse to make more calls
// until the reset window passes. This protects every user, not just the
// one whose request tripped it.

interface ErrorLimitState {
  remaining: number
  resetAt: number // unix ms
}

const errorLimit: ErrorLimitState = {
  remaining: 100,
  resetAt: 0,
}

const updateErrorLimit = (headers: Headers): void => {
  const remain = headers.get('x-esi-error-limit-remain')
  const reset = headers.get('x-esi-error-limit-reset')
  if (remain !== null) errorLimit.remaining = Number(remain)
  if (reset !== null) errorLimit.resetAt = Date.now() + Number(reset) * 1000
}

const errorLimitIsHealthy = (): boolean => {
  if (Date.now() >= errorLimit.resetAt) {
    errorLimit.remaining = 100
    return true
  }
  return errorLimit.remaining > 10 // leave some buffer
}

// --- User-Agent -----------------------------------------------------------

const buildUserAgent = (cfg: EveConfig): string =>
  `eve-pds/0.1.0 (${cfg.contactEmail}; +https://edencom.link/) atproto-pds/eve-sso`;

// --- Token freshness ------------------------------------------------------

const isAccessTokenFresh = (t: StoredTokens): boolean =>
  Date.now() + ACCESS_TOKEN_SLACK_MS < t.accessExpiresAt

/**
 * Ensure we have a usable access token for this character, refreshing if
 * needed. Persists the rotated refresh_token atomically before returning.
 *
 * Throws if the token has been invalidated (user revoked, etc). Callers
 * should surface this to the user with "please re-authenticate via /eve/login".
 */
export class TokensInvalidatedError extends Error {
  constructor(readonly characterId: number, reason: string) {
    super(`EVE tokens invalidated for character ${characterId}: ${reason}`)
    this.name = 'TokensInvalidatedError'
  }
}

export const ensureFreshAccessToken = async (
  cfg: EveConfig,
  store: TokenStore,
  characterId: number,
): Promise<string> => {
  const stored = store.get(characterId)
  if (!stored) {
    throw new TokensInvalidatedError(characterId, 'no tokens stored')
  }
  if (stored.invalidatedAt !== null) {
    throw new TokensInvalidatedError(characterId, 'previously invalidated')
  }
  if (isAccessTokenFresh(stored)) {
    return stored.accessToken
  }

  try {
    const refreshed = await refreshAccessToken(cfg, stored.refreshToken)
    // Re-verify the new access token so we're sure it's valid before we
    // persist - this also catches scope changes server-side.
    await verifyAccessToken(cfg, refreshed.access_token)

    const next: StoredTokens = {
      characterId,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token, // may equal stored.refreshToken, may not
      accessExpiresAt: Date.now() + refreshed.expires_in * 1000,
      scopes: stored.scopes,
      invalidatedAt: null,
    }
    // Persist BEFORE returning. If this throws, we return the error to
    // the caller without the tokens being exposed downstream - the old
    // refresh token may still be valid (EVE rotation is not guaranteed).
    store.upsert(next)
    return next.accessToken
  } catch (err) {
    if (err instanceof TokenRefreshError) {
      // 4xx - permanent. Most commonly "invalid_grant" when the user
      // revokes the app or the refresh token is truly expired.
      store.markInvalid(characterId, `${err.status}: ${err.body.slice(0, 200)}`)
      throw new TokensInvalidatedError(characterId, err.message)
    }
    throw err
  }
}

// --- ESI call -------------------------------------------------------------

export interface EsiResponse<T> {
  readonly data: T
  readonly expires: Date | null
  readonly lastModified: Date | null
  readonly etag: string | null
}

const parseDate = (v: string | null): Date | null => {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

const extractCacheHeaders = (
  res: Response,
): Omit<EsiResponse<unknown>, 'data'> => ({
  expires: parseDate(res.headers.get('expires')),
  lastModified: parseDate(res.headers.get('last-modified')),
  etag: res.headers.get('etag'),
})

export class EsiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'EsiError'
  }
}

export class EsiRateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`ESI error-limit window exhausted; retry in ${retryAfterMs}ms`)
    this.name = 'EsiRateLimitedError'
  }
}

export interface EsiCallDeps {
  readonly cfg: EveConfig
  readonly tokens: TokenStore
}

/**
 * GET a character-scoped ESI endpoint. Path should be relative to
 * /latest, e.g. `/characters/${id}/ship/`.
 *
 * Returns parsed body + cache metadata. Does NOT cache on our side - the
 * caller is responsible for respecting `expires` before calling again.
 */
export const callEsi = async <T>(
  deps: EsiCallDeps,
  characterId: number,
  path: string,
  opts: { etag?: string } = {},
): Promise<EsiResponse<T>> => {
  if (!errorLimitIsHealthy()) {
    throw new EsiRateLimitedError(Math.max(0, errorLimit.resetAt - Date.now()))
  }
  const accessToken = await ensureFreshAccessToken(
    deps.cfg,
    deps.tokens,
    characterId,
  )

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': buildUserAgent(deps.cfg),
    Accept: 'application/json',
  }
  if (opts.etag) headers['If-None-Match'] = opts.etag

  const res = await fetch(`${ESI_BASE}${path}`, { headers })
  updateErrorLimit(res.headers)

  if (res.status === 304) {
    // Not modified - caller should use its cached copy.
    return {
      data: null as unknown as T,
      ...extractCacheHeaders(res),
    }
  }
  if (!res.ok) {
    const text = await res.text()
    if (res.status === 420) {
      throw new EsiRateLimitedError(
        Math.max(0, errorLimit.resetAt - Date.now()),
      )
    }
    if (res.status === 403) {
      // Usually missing scope. Surface explicitly.
      throw new EsiError(
        `ESI 403 (likely missing scope for ${path}): ${text}`,
        403,
        text,
      )
    }
    throw new EsiError(`ESI ${res.status} on ${path}: ${text}`, res.status, text)
  }
  const data = (await res.json()) as T
  return { data, ...extractCacheHeaders(res) }
}

// --- Typed endpoint wrappers (tiny, add as needed) ------------------------

export interface EsiShip {
  readonly ship_item_id: number
  readonly ship_name: string
  readonly ship_type_id: number
}

export const getCharacterShip = R.curry(
  (deps: EsiCallDeps, characterId: number) =>
    callEsi<EsiShip>(deps, characterId, `/characters/${characterId}/ship/`),
)

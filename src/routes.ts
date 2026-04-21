import * as crypto from 'node:crypto'
import express, { type Router, type Request, type Response } from 'express'
import type { AppConfig } from './config.js'
import type { StateStore } from './state-store.js'
import type { CharacterStore } from './character-store.js'
import type { TokenStore } from './token-store.js'
import type { UserStore } from './user-store.js'
import {
  buildAuthorizeUrl,
  codeChallengeFor,
  exchangeCodeForToken,
  generateCodeVerifier,
  verifyAccessToken,
} from './eve-sso.js'
import { provisionSession, type ProvisionDeps } from './provision.js'
import {
  getCharacterShip,
  EsiError,
  EsiRateLimitedError,
  TokensInvalidatedError,
} from './esi-client.js'
import { extractSupabaseUser } from './supabase-auth.js'

export interface RouterDeps {
  readonly config: AppConfig
  readonly stateStore: StateStore
  readonly characters: CharacterStore
  readonly tokens: TokenStore
  readonly users: UserStore
  readonly pdsUrl: string
  readonly adminPassword: string
}

const randomState = (): string =>
  crypto.randomBytes(16).toString('base64url')

// --- POST /eve/start-binding -----------------------------------------------
// Called by the web app (with Supabase bearer token) to kick off the EVE SSO
// flow. Returns the EVE authorization URL; the client then redirects there.

const handleStartBinding =
  (deps: RouterDeps) =>
  async (req: Request, res: Response): Promise<void> => {
    const userId = await extractSupabaseUser(
      req.headers.authorization,
      deps.config.supabaseUrl,
      deps.config.supabaseSecretKey,
    )
    if (!userId) {
      res.status(401).json({ error: 'Missing or invalid authorization' })
      return
    }

    const state = randomState()
    const verifier = generateCodeVerifier()
    const challenge = codeChallengeFor(verifier)
    deps.stateStore.put(state, verifier, userId)
    const url = buildAuthorizeUrl(deps.config.eve, {
      state,
      codeChallenge: challenge,
    })
    res.json({ url })
  }

// --- GET /eve/callback --------------------------------------------------------

const handleCallback =
  (deps: RouterDeps) =>
  async (req: Request, res: Response): Promise<void> => {
    const webAppUrl = deps.config.webAppUrl

    const code = typeof req.query.code === 'string' ? req.query.code : null
    const state = typeof req.query.state === 'string' ? req.query.state : null
    const errParam =
      typeof req.query.error === 'string' ? req.query.error : null

    if (errParam) {
      const dest = new URL('/dashboard', webAppUrl)
      dest.searchParams.set('eve_error', `EVE SSO error: ${errParam}`)
      res.redirect(dest.toString())
      return
    }
    if (!code || !state) {
      const dest = new URL('/dashboard', webAppUrl)
      dest.searchParams.set('eve_error', 'Missing code or state')
      res.redirect(dest.toString())
      return
    }
    const rec = deps.stateStore.take(state)
    if (!rec) {
      const dest = new URL('/dashboard', webAppUrl)
      dest.searchParams.set('eve_error', 'Invalid or expired state — please try again')
      res.redirect(dest.toString())
      return
    }

    try {
      const tokens = await exchangeCodeForToken(
        deps.config.eve,
        code,
        rec.codeVerifier,
      )
      const character = await verifyAccessToken(
        deps.config.eve,
        tokens.access_token,
      )

      const provisionDeps: ProvisionDeps = {
        pdsUrl: deps.pdsUrl,
        pdsHostname: deps.config.hostname,
        adminPassword: deps.adminPassword,
        characters: deps.characters,
        tokens: deps.tokens,
        eveCfg: deps.config.eve,
      }
      await provisionSession(provisionDeps, character, tokens)

      deps.users.bind(rec.supabaseUserId, character.characterId)

      const dest = new URL('/dashboard', webAppUrl)
      dest.searchParams.set('eve_bound', 'true')
      res.redirect(dest.toString())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const dest = new URL('/dashboard', webAppUrl)
      dest.searchParams.set('eve_error', msg)
      res.redirect(dest.toString())
    }
  }

// --- GET /api/account -------------------------------------------------------
// Returns the EVE character bound to the authenticated Supabase user.

const handleGetAccount =
  (deps: RouterDeps) =>
  async (req: Request, res: Response): Promise<void> => {
    const userId = await extractSupabaseUser(
      req.headers.authorization,
      deps.config.supabaseUrl,
      deps.config.supabaseSecretKey,
    )
    if (!userId) {
      res.status(401).json({ error: 'Missing or invalid authorization' })
      return
    }

    const binding = deps.users.findByUserId(userId)
    if (!binding) {
      res.json({ bound: false })
      return
    }

    const character = deps.characters.findByCharacterId(binding.characterId)
    if (!character) {
      res.json({ bound: false })
      return
    }

    res.json({
      bound: true,
      characterId: character.characterId,
      handle: character.handle,
      did: character.did,
    })
  }

// --- GET /eve/me/ship (demo ESI call) -----------------------------------------

interface AtpAccessPayload {
  readonly sub?: string
}

const parseAtpJwt = (authz: string | undefined): AtpAccessPayload | null => {
  if (!authz || !authz.startsWith('Bearer ')) return null
  const token = authz.slice('Bearer '.length)
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString('utf8'),
    ) as AtpAccessPayload
    return payload
  } catch {
    return null
  }
}

const handleMyShip =
  (deps: RouterDeps) =>
  async (req: Request, res: Response): Promise<void> => {
    const payload = parseAtpJwt(req.headers.authorization)
    const did = payload?.sub
    if (!did) {
      res.status(401).json({ error: 'missing or malformed bearer token' })
      return
    }

    const mapping = deps.characters.findByDid(did)
    if (!mapping) {
      res.status(404).json({ error: 'no EVE character mapped to this DID' })
      return
    }

    try {
      const esiDeps = { cfg: deps.config.eve, tokens: deps.tokens }
      const resp = await getCharacterShip(esiDeps, mapping.characterId)
      res.json({
        characterId: mapping.characterId,
        ship: resp.data,
        cache: {
          expires: resp.expires?.toISOString() ?? null,
          lastModified: resp.lastModified?.toISOString() ?? null,
          etag: resp.etag,
        },
      })
    } catch (err) {
      if (err instanceof TokensInvalidatedError) {
        res.status(401).json({
          error: 'eve_tokens_invalid',
          message:
            'Your EVE authorization has expired or been revoked. ' +
            'Please re-authenticate via the website.',
        })
        return
      }
      if (err instanceof EsiRateLimitedError) {
        res.status(503).json({
          error: 'esi_rate_limited',
          retryAfterMs: err.retryAfterMs,
        })
        return
      }
      if (err instanceof EsiError) {
        res.status(err.status).json({
          error: 'esi_error',
          message: err.message,
          hint:
            err.status === 403
              ? 'This endpoint needs the esi-location.read_ship_type.v1 scope. ' +
                'Add it to EVE_SCOPES and re-authenticate.'
              : undefined,
        })
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: 'internal', message: msg })
    }
  }

// --- Blocker --------------------------------------------------------------

const blockPasswordAuth = (_req: Request, res: Response): void => {
  res.status(403).json({
    error: 'AuthMethodNotSupported',
    message:
      'This PDS uses EVE Online SSO exclusively. ' +
      'Please sign up at the website and bind your EVE character there.',
  })
}

export const buildEveRouter = (deps: RouterDeps): Router => {
  const router = express.Router()
  router.post('/eve/start-binding', handleStartBinding(deps))
  router.get('/eve/callback', handleCallback(deps))
  router.get('/eve/me/ship', handleMyShip(deps))
  router.get('/api/account', handleGetAccount(deps))
  return router
}

export const buildBlockerRouter = (): Router => {
  const router = express.Router()
  router.post('/xrpc/com.atproto.server.createAccount', blockPasswordAuth)
  return router
}

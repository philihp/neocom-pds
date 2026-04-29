import * as crypto from "node:crypto"
import express, {
  type Router,
  type Request,
  type Response,
  type NextFunction,
} from "express"
import type { AppConfig } from "./config.js"
import type { StateStore } from "./state-store.js"
import type { CharacterStore } from "./character-store.js"
import type { TokenStore } from "./token-store.js"
import type { UserStore } from "./user-store.js"
import {
  buildAuthorizeUrl,
  codeChallengeFor,
  exchangeCodeForToken,
  generateCodeVerifier,
  verifyAccessToken,
} from "./eve-sso.js"
import {
  provisionSession,
  resetAndLogin,
  updateHandleForDid,
  type ProvisionDeps,
  type AdminDeps,
} from "./provision.js"
import {
  getCharacterShip,
  EsiError,
  EsiRateLimitedError,
  TokensInvalidatedError,
} from "./esi-client.js"
import {
  extractSupabaseUser,
  getSupabaseUserEmail,
  validateSupabasePassword,
} from "./supabase-auth.js"

export interface RouterDeps {
  readonly config: AppConfig
  readonly stateStore: StateStore
  readonly characters: CharacterStore
  readonly tokens: TokenStore
  readonly users: UserStore
  readonly pdsUrl: string
  readonly pdsServiceHandleDomains: string
  readonly adminPassword: string
}

const randomState = (): string => crypto.randomBytes(16).toString("base64url")

// --- GET /eve/login --------------------------------------------------------
// Browser-accessible entry point: redirects directly to EVE SSO.

const handleLogin =
  (deps: RouterDeps) =>
  (req: Request, res: Response): void => {
    const state = randomState()
    const verifier = generateCodeVerifier()
    const challenge = codeChallengeFor(verifier)
    deps.stateStore.put(state, verifier, null)
    const url = buildAuthorizeUrl(deps.config.eve, {
      state,
      codeChallenge: challenge,
    })
    res.redirect(url)
  }

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
      res.status(401).json({ error: "Missing or invalid authorization" })
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

// --- POST /eve/start-handle-change -------------------------------------------
// Web-only endpoint. The user provides a desired new ATProto handle; we store
// the intent in the OAuth state and kick off EVE SSO to confirm their identity.
// The actual handle update happens in /eve/callback once SSO succeeds.

interface StartHandleChangeBody {
  readonly handle?: unknown
}

const handleStartHandleChange =
  (deps: RouterDeps) =>
  async (req: Request, res: Response): Promise<void> => {
    const userId = await extractSupabaseUser(
      req.headers.authorization,
      deps.config.supabaseUrl,
      deps.config.supabaseSecretKey,
    )
    if (!userId) {
      res.status(401).json({ error: "Missing or invalid authorization" })
      return
    }

    const body = req.body as StartHandleChangeBody
    const newHandle =
      typeof body.handle === "string" ? body.handle.trim() : null
    if (!newHandle) {
      res
        .status(400)
        .json({ error: "InvalidRequest", message: "handle is required" })
      return
    }

    // Verify the user already has a bound character — handle changes only make
    // sense for existing accounts.
    const binding = deps.users.findByUserId(userId)
    if (!binding) {
      res
        .status(400)
        .json({
          error: "NotBound",
          message:
            "No EVE character bound to this account. Complete onboarding first.",
        })
      return
    }

    const state = randomState()
    const verifier = generateCodeVerifier()
    const challenge = codeChallengeFor(verifier)
    deps.stateStore.put(state, verifier, userId, newHandle)
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

    const code = typeof req.query.code === "string" ? req.query.code : null
    const state = typeof req.query.state === "string" ? req.query.state : null
    const errParam =
      typeof req.query.error === "string" ? req.query.error : null

    if (errParam) {
      const dest = new URL("/", webAppUrl)
      dest.searchParams.set("eve_error", `EVE SSO error: ${errParam}`)
      res.redirect(dest.toString())
      return
    }
    if (!code || !state) {
      const dest = new URL("/", webAppUrl)
      dest.searchParams.set("eve_error", "Missing code or state")
      res.redirect(dest.toString())
      return
    }
    const rec = deps.stateStore.take(state)
    if (!rec) {
      const dest = new URL("/", webAppUrl)
      dest.searchParams.set(
        "eve_error",
        "Invalid or expired state — please try again",
      )
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

      const adminDeps: AdminDeps = {
        pdsUrl: deps.pdsUrl,
        adminPassword: deps.adminPassword,
      }

      if (rec.newHandle) {
        // Handle-change flow: confirm the user still owns this character, then
        // update the ATProto handle. We require the character to already exist.
        const existing = deps.characters.findByCharacterId(
          character.characterId,
        )
        if (!existing) {
          throw new Error(
            "No existing account found for this EVE character. Complete onboarding first.",
          )
        }
        if (existing.owner !== character.owner) {
          throw new Error(
            "EVE character appears to have changed ownership. Handle change denied.",
          )
        }

        await updateHandleForDid(adminDeps, existing.did, rec.newHandle)
        deps.characters.updateHandle(character.characterId, rec.newHandle)

        const dest = new URL("/", webAppUrl)
        dest.searchParams.set("handle_changed", "true")
        res.redirect(dest.toString())
      } else {
        // not rec.newHandle
        const provisionDeps: ProvisionDeps = {
          pdsUrl: deps.pdsUrl,
          pdsServiceHandleDomains: deps.pdsServiceHandleDomains,
          pdsHostname: deps.config.hostname,
          adminPassword: deps.adminPassword,
          characters: deps.characters,
          tokens: deps.tokens,
          eveCfg: deps.config.eve,
        }
        const session = await provisionSession(provisionDeps, character, tokens)

        if (rec.supabaseUserId) {
          deps.users.bind(rec.supabaseUserId, character.characterId)
        }

        const dest = new URL("/", webAppUrl)
        // dest.searchParams.set("eve_bound", session.handle)
        res.redirect(dest.toString())
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const dest = new URL("/", webAppUrl)
      dest.searchParams.set("eve_error", msg)
      res.redirect(dest.toString())
    }
  }

// --- POST /eve/transfer-binding ---------------------------------------------
// Called by the web app when an existing Supabase user is detected after EVE
// OAuth. The anon user's token proves ownership of the just-bound character;
// we re-map that binding to the existing (permanent) Supabase user ID.

interface TransferBindingBody {
  readonly targetUserId?: unknown
}

const handleTransferBinding =
  (deps: RouterDeps) =>
  async (req: Request, res: Response): Promise<void> => {
    const anonUserId = await extractSupabaseUser(
      req.headers.authorization,
      deps.config.supabaseUrl,
      deps.config.supabaseSecretKey,
    )
    if (!anonUserId) {
      res.status(401).json({ error: "Missing or invalid authorization" })
      return
    }

    const body = req.body as TransferBindingBody
    const targetUserId =
      typeof body.targetUserId === "string" ? body.targetUserId.trim() : null
    if (!targetUserId) {
      res.status(400).json({ error: "InvalidRequest", message: "targetUserId is required" })
      return
    }

    const binding = deps.users.findByUserId(anonUserId)
    if (!binding) {
      res.status(404).json({ error: "NotBound", message: "No EVE character bound to this session" })
      return
    }

    deps.users.bind(targetUserId, binding.characterId)
    res.json({ ok: true })
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
      res.status(401).json({ error: "Missing or invalid authorization" })
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
      characterName: character.characterName,
      handle: character.handle,
      did: character.did,
    })
  }

// --- GET /eve/me/ship (demo ESI call) -----------------------------------------

interface AtpAccessPayload {
  readonly sub?: string
}

const parseAtpJwt = (authz: string | undefined): AtpAccessPayload | null => {
  if (!authz || !authz.startsWith("Bearer ")) return null
  const token = authz.slice("Bearer ".length)
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
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
      res.status(401).json({ error: "missing or malformed bearer token" })
      return
    }

    const mapping = deps.characters.findByDid(did)
    if (!mapping) {
      res.status(404).json({ error: "no EVE character mapped to this DID" })
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
          error: "eve_tokens_invalid",
          message:
            "Your EVE authorization has expired or been revoked. " +
            "Please re-authenticate via the website.",
        })
        return
      }
      if (err instanceof EsiRateLimitedError) {
        res.status(503).json({
          error: "esi_rate_limited",
          retryAfterMs: err.retryAfterMs,
        })
        return
      }
      if (err instanceof EsiError) {
        res.status(err.status).json({
          error: "esi_error",
          message: err.message,
          hint:
            err.status === 403
              ? "This endpoint needs the esi-location.read_ship_type.v1 scope. " +
                "Add it to EVE_SCOPES and re-authenticate."
              : undefined,
        })
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: "internal", message: msg })
    }
  }

// --- POST /xrpc/com.atproto.server.createSession --------------------------
// Intercepts the native-app login flow. The user supplies their ATProto
// handle (or DID) and their Supabase password. We validate against Supabase,
// then use the admin API to mint a fresh ATProto session — same as EVE SSO
// does on each re-auth.

interface CreateSessionBody {
  readonly identifier?: unknown
  readonly password?: unknown
}

const handleCreateSession =
  (deps: RouterDeps) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Internal calls (e.g. from resetAndLogin) carry a freshly-generated random
    // password that Supabase knows nothing about. Pass them straight through to
    // the underlying PDS handler which validates against its own password store.
    const ip = req.ip ?? req.socket.remoteAddress ?? ""
    const isLoopback =
      ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1"
    if (isLoopback) {
      next()
      return
    }

    const body = req.body as CreateSessionBody
    const identifier =
      typeof body.identifier === "string" ? body.identifier : null
    const password = typeof body.password === "string" ? body.password : null

    if (!identifier || !password) {
      res
        .status(400)
        .json({
          error: "InvalidRequest",
          message: "identifier and password are required",
        })
      return
    }

    // Resolve identifier (handle or DID) to a character mapping.
    const character = identifier.startsWith("did:")
      ? deps.characters.findByDid(identifier)
      : deps.characters.findByHandle(identifier)

    if (!character) {
      res
        .status(401)
        .json({
          error: "AuthenticationRequired",
          message: "Account not found or not bound to an EVE character",
        })
      return
    }

    // Find the Supabase user bound to this character.
    const binding = deps.users.findByCharacterId(character.characterId)
    if (!binding) {
      res
        .status(401)
        .json({
          error: "AuthenticationRequired",
          message:
            "No Supabase account bound to this character. Please log in via the website first.",
        })
      return
    }

    // Fetch their email so we can validate the password.
    const email = await getSupabaseUserEmail(
      binding.supabaseUserId,
      deps.config.supabaseUrl,
      deps.config.supabaseSecretKey,
    )
    if (!email) {
      res.status(500).json({
        error: "InternalError",
        message: `Could not retrieve account email for ${binding.supabaseUserId}`,
      })
      return
    }

    const valid = await validateSupabasePassword(
      email,
      password,
      deps.config.supabaseUrl,
      deps.config.supabaseAnonKey,
    )
    if (!valid) {
      res
        .status(401)
        .json({ error: "AuthenticationRequired", message: "Invalid password" })
      return
    }

    // Credentials check out — mint a fresh ATProto session via the admin reset trick.
    const adminDeps: AdminDeps = {
      pdsUrl: deps.pdsUrl,
      adminPassword: deps.adminPassword,
    }
    try {
      const session = await resetAndLogin(adminDeps, character.did)
      res.json(session)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: "InternalError", message: msg })
    }
  }

// --- Blocker --------------------------------------------------------------

const blockExternal =
  (message: string) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? ""
    const isLoopback =
      ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1"
    if (isLoopback) {
      next()
      return
    }
    res.status(403).json({ error: "AuthMethodNotSupported", message })
  }

// --- GET /.well-known/atproto-did -------------------------------------------
// Handle verification for subdomain handles (e.g. pilot.pds-hostname).
// Bluesky resolves a handle by fetching https://<handle>/.well-known/atproto-did
// and expecting the bare DID back. Requires wildcard DNS *.pds-hostname → this
// server; the Host header then tells us which character is being looked up.

const handleAtprotoWellKnown =
  (deps: RouterDeps) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const character = deps.characters.findByHandle(req.hostname)
    if (!character) {
      next()
      return
    }
    res.type("text/plain").send(character.did)
  }

export const buildEveRouter = (deps: RouterDeps): Router => {
  const router = express.Router()
  router.get("/.well-known/atproto-did", handleAtprotoWellKnown(deps))
  router.get("/eve/login", handleLogin(deps))
  router.post("/eve/start-binding", express.json(), handleStartBinding(deps))
  router.post(
    "/eve/transfer-binding",
    express.json(),
    handleTransferBinding(deps),
  )
  router.post(
    "/eve/start-handle-change",
    express.json(),
    handleStartHandleChange(deps),
  )
  router.get("/eve/callback", handleCallback(deps))
  router.get("/eve/me/ship", handleMyShip(deps))
  router.get("/api/account", handleGetAccount(deps))
  router.post(
    "/xrpc/com.atproto.server.createSession",
    express.json(),
    handleCreateSession(deps),
  )
  return router
}

export const buildBlockerRouter = (): Router => {
  const router = express.Router()
  router.post(
    "/xrpc/com.atproto.server.createAccount",
    blockExternal(
      "This PDS uses EVE Online SSO exclusively. " +
        "Please sign up at the website and bind your EVE character there.",
    ),
  )
  router.post(
    "/xrpc/com.atproto.identity.updateHandle",
    blockExternal(
      "Handle changes must be done through the website. " +
        'Visit the dashboard and use the "Change Username" flow to re-authenticate via EVE Online SSO.',
    ),
  )
  return router
}

// --- Debug router (temporary) ------------------------------------------------

export const buildDebugRouter = (deps: RouterDeps): Router => {
  const router = express.Router()

  router.get("/debug/stores", (_req, res) => {
    const characters = deps.characters.listAll()
    const users = deps.users.listAll()
    const tokens = deps.tokens.listAllMeta()

    // Join everything together for easy reading
    const enriched = characters.map((c) => {
      const user = deps.users.findByCharacterId(c.characterId)
      const token = tokens.find((t) => t.characterId === c.characterId)
      return {
        character: c,
        supabaseUserId: user?.supabaseUserId ?? null,
        boundAt: user?.boundAt ?? null,
        token: token
          ? {
              accessExpiresAt: new Date(token.accessExpiresAt).toISOString(),
              scopes: token.scopes,
              valid: token.invalidatedAt === null,
              invalidatedReason: token.invalidatedReason,
            }
          : null,
      }
    })

    res.json({
      characters: enriched,
      unboundUsers: users.filter(
        (u) => !characters.some((c) => c.characterId === u.characterId),
      ),
      tokenCount: tokens.length,
    })
  })

  return router
}

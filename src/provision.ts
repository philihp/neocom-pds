import * as crypto from 'node:crypto'
import { AtpAgent } from '@atproto/api'
import type { EveConfig } from './config.js'
import type { EveCharacter } from './identity.js'
import { handleFor, handleForWithId } from './identity.js'
import type { CharacterStore } from './character-store.js'
import type { TokenStore } from './token-store.js'
import type { TokenResponse } from './eve-sso.js'

export interface AtpSession {
  readonly did: string
  readonly handle: string
  readonly accessJwt: string
  readonly refreshJwt: string
}

export interface AdminDeps {
  readonly pdsUrl: string
  readonly adminPassword: string
}

export interface ProvisionDeps extends AdminDeps {
  readonly pdsHostname: string
  readonly characters: CharacterStore
  readonly tokens: TokenStore
  readonly eveCfg: EveConfig
}

// EVE SSO is the sole credential, but the PDS still wants a password field
// for com.atproto.server.createAccount and createSession. We generate a
// long random one per account, store nothing, and never surface it.
// After account creation we immediately have a session JWT, which is all
// the client needs. The EVE user logs in again via SSO -> we mint a new
// session using the per-account password we can't recover... which means
// we actually DO need to keep it somewhere. Options:
//   (a) store it encrypted in the character_account table
//   (b) reset the password on every login (admin endpoint)
// (b) is cleaner - no secret at rest - so we use admin updateAccountPassword.

const generatePassword = (): string =>
  crypto.randomBytes(32).toString('base64url')

const adminAuth = (password: string): string =>
  'Basic ' + Buffer.from(`admin:${password}`).toString('base64')

/**
 * Create a brand new atproto account for this EVE character.
 * Returns the initial session.
 */
const createAccount = async (
  deps: ProvisionDeps,
  char: EveCharacter,
  handle: string,
): Promise<{ session: AtpSession; password: string }> => {
  const password = generatePassword()
  const agent = new AtpAgent({ service: deps.pdsUrl })
  // Per-character synthetic email. Deliverability is irrelevant since we
  // never send mail to it; it just satisfies the PDS's email uniqueness
  // requirement. Using a reserved-for-docs TLD keeps it clearly non-routable.
  const email = `eve-${char.characterId}@invalid.local`

  const res = await agent.api.com.atproto.server.createAccount({
    handle,
    email,
    password,
  })

  return {
    session: {
      did: res.data.did,
      handle: res.data.handle,
      accessJwt: res.data.accessJwt,
      refreshJwt: res.data.refreshJwt,
    },
    password,
  }
}

/**
 * Reset the password for an existing account to a freshly-generated value,
 * then log in with it to mint a session. Uses the PDS admin endpoint.
 */
export const resetAndLogin = async (
  deps: AdminDeps,
  did: string,
): Promise<AtpSession> => {
  const password = generatePassword()

  const resetRes = await fetch(
    `${deps.pdsUrl}/xrpc/com.atproto.admin.updateAccountPassword`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: adminAuth(deps.adminPassword),
      },
      body: JSON.stringify({ did, password }),
    },
  )
  if (!resetRes.ok) {
    const text = await resetRes.text()
    throw new Error(`updateAccountPassword failed (${resetRes.status}): ${text}`)
  }

  const agent = new AtpAgent({ service: deps.pdsUrl })
  const login = await agent.api.com.atproto.server.createSession({
    identifier: did,
    password,
  })
  return {
    did: login.data.did,
    handle: login.data.handle,
    accessJwt: login.data.accessJwt,
    refreshJwt: login.data.refreshJwt,
  }
}

export const provisionSession = async (
  deps: ProvisionDeps,
  char: EveCharacter,
  eveTokens: TokenResponse,
): Promise<AtpSession> => {
  const persistEveTokens = (): void => {
    deps.tokens.upsert({
      characterId: char.characterId,
      accessToken: eveTokens.access_token,
      refreshToken: eveTokens.refresh_token,
      accessExpiresAt: Date.now() + eveTokens.expires_in * 1000,
      scopes: deps.eveCfg.scopes,
      invalidatedAt: null,
    })
  }

  const existing = deps.characters.findByCharacterId(char.characterId)

  if (existing) {
    // Detect character transfer. EVE's owner hash changes when a character
    // is sold. We DO NOT let a new owner assume the existing atproto DID -
    // that would hand them the previous owner's repo.
    if (existing.owner !== char.owner) {
      throw new Error(
        'EVE character appears to have changed ownership. ' +
          'This account is locked and must be manually reviewed.',
      )
    }
    // Refresh stored EVE tokens - user just completed SSO, so these are fresh.
    persistEveTokens()
    return resetAndLogin(deps, existing.did)
  }

  // New character - create an account.
  const primaryHandle = handleFor(deps.pdsHostname, char.characterName)
  let handle = primaryHandle
  let created
  try {
    created = await createAccount(deps, char, handle)
  } catch (err) {
    // On handle collision, fall back to disambiguated form.
    const msg = err instanceof Error ? err.message : String(err)
    if (/handle/i.test(msg) && /taken|unavailable|already/i.test(msg)) {
      handle = handleForWithId(deps.pdsHostname, char)
      created = await createAccount(deps, char, handle)
    } else {
      throw err
    }
  }

  deps.characters.insert({
    characterId: char.characterId,
    did: created.session.did,
    handle: created.session.handle,
    owner: char.owner,
  })
  persistEveTokens()

  return created.session
}

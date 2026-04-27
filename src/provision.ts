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
  readonly pdsHostname: string;
  readonly pdsServiceHandleDomains: string;
  readonly characters: CharacterStore;
  readonly tokens: TokenStore;
  readonly eveCfg: EveConfig;
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

// Parse SQLite datetime('now') strings ("YYYY-MM-DD HH:MM:SS") or ISO strings.
const parseCreatedAt = (raw: string): Date =>
  new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z')

const eveBirthDate = (createdAt: string): string => {
  const d = parseCreatedAt(createdAt)
  d.setUTCFullYear(d.getUTCFullYear() - 1898)
  return d.toISOString()
}

const setEveProfile = async (
  pdsUrl: string,
  session: AtpSession,
  char: EveCharacter,
  createdAt: string,
): Promise<void> => {
  const agent = new AtpAgent({ service: pdsUrl })
  await agent.resumeSession({
    did: session.did,
    handle: session.handle,
    accessJwt: session.accessJwt,
    refreshJwt: session.refreshJwt,
    active: true,
  })

  const portraitRes = await fetch(
    `https://images.evetech.net/characters/${char.characterId}/portrait?size=512`,
  );
  if (!portraitRes.ok) throw new Error(`EVE portrait fetch failed: ${portraitRes.status}`)
  const portrait = Buffer.from(await portraitRes.arrayBuffer())

  const blobRes = await agent.api.com.atproto.repo.uploadBlob(portrait, {
    encoding: 'image/jpeg',
  })

  await agent.api.com.atproto.repo.putRecord({
    repo: session.did,
    collection: 'app.bsky.actor.profile',
    rkey: 'self',
    record: {
      $type: 'app.bsky.actor.profile',
      displayName: char.characterName,
      avatar: blobRes.data.blob,
      birthDate: eveBirthDate(createdAt),
    },
  })
}

/**
 * Update the ATProto handle for an existing account. Uses admin password-reset
 * to obtain a live session, then calls identity.updateHandle on behalf of the user.
 */
export const updateHandleForDid = async (
  deps: AdminDeps,
  did: string,
  newHandle: string,
): Promise<void> => {
  const session = await resetAndLogin(deps, did)
  const agent = new AtpAgent({ service: deps.pdsUrl })
  await agent.resumeSession({
    did: session.did,
    handle: session.handle,
    accessJwt: session.accessJwt,
    refreshJwt: session.refreshJwt,
    active: true,
  })
  await agent.api.com.atproto.identity.updateHandle({ handle: newHandle })
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
      console.error(
        `observed ownership change on ${char.characterId} from ${existing.owner} to ${char.owner}`,
      );
      throw new Error(
        "EVE character appears to have changed ownership. " +
          "Please contact an Edencom PDS support for manual review.",
      );
    }
    persistEveTokens()
    const session = await resetAndLogin(deps, existing.did)
    setEveProfile(deps.pdsUrl, session, char, existing.createdAt).catch(
      (err) => {
        console.error(`setEveProfile failed for${char.characterId}`, err);
      },
    );
    return session
  }

  // New character - create an account.
  const primaryHandle = handleFor(
    deps.pdsServiceHandleDomains,
    char.characterName,
  );
  console.log({
    primaryHandle,
    pdsHostname: deps.pdsHostname,
    characterName: char.characterName,
  });
  let handle = primaryHandle
  let created
  try {
    created = await createAccount(deps, char, handle)
  } catch (err) {
    // On handle collision, fall back to disambiguated form.
    const msg = err instanceof Error ? err.message : String(err)
    if (/handle/i.test(msg) && /taken|unavailable|already/i.test(msg)) {
      handle = handleForWithId(deps.pdsServiceHandleDomains, char);
      created = await createAccount(deps, char, handle)
    } else {
      throw err
    }
  }

  deps.characters.insert({
    characterId: char.characterId,
    characterName: char.characterName,
    did: created.session.did,
    handle: created.session.handle,
    owner: char.owner,
  });
  persistEveTokens()

  const createdAt = new Date().toISOString()
  setEveProfile(deps.pdsUrl, created.session, char, createdAt).catch((err) =>
    console.error('setEveProfile failed for', char.characterId, err),
  )

  return created.session
}

# eve-pds

An [ATProto](https://atproto.com) Personal Data Server that uses EVE Online
SSO as its sole authentication method, and keeps each user's EVE refresh
token on file so the service can make authenticated ESI calls on their
behalf. One EVE character = one atproto account.

Built as a wrapper around `@atproto/pds` — the stock PDS runs embedded,
and this service mounts the EVE SSO flow plus ESI call paths on top.

## Flow

```
    /eve/login                /eve/callback                 /eve/me/ship
        │                          │                              │
        ▼                          ▼                              ▼
  redirect to CCP         exchange code + JWT           decode atproto JWT
  with PKCE S256          verify via JWKS                   ↓
  + random state             ↓                          look up character
        │                 create-or-resolve                  ↓
        ▼                 atproto account                refresh EVE access
  user authenticates         ↓                          token if stale
  at login.eveonline.com  encrypt + store EVE              ↓
        │                 refresh token                  GET esi.evetech.net
        │                    ↓                             ↓
        └────────────────▶ return atproto          respond with ship data
                           session JSON            + cache expires/etag
```

## What's stored for each character

Two side tables, colocated with the PDS data dir, completely separate
from the PDS's own account DB:

- `character_account` — `character_id → (did, handle, owner)`. The `owner`
  is EVE's opaque hash that changes when a character is transferred; used
  to block stolen-character takeovers.
- `eve_token` — encrypted access + refresh tokens, scope list, expiry,
  invalidation marker. AES-256-GCM with a 32-byte key from
  `EVE_TOKEN_ENCRYPTION_KEY` (rotating the key locks every user out
  until they re-authenticate).

Refresh tokens **rotate** — EVE's v2 endpoint may return a new refresh
token on every call, and the old one is immediately invalidated. The
token store writes the new token to disk *before* the ESI client returns
the new access token to the caller. If the write fails, we surface the
error and don't expose the new tokens, so the old refresh token (which
may or may not still be valid) remains the last written state.

## Scopes

Default `EVE_SCOPES=publicData` gives identity only — enough to create
and log into accounts, nothing else. To use the `/eve/me/ship` demo
endpoint, add `esi-location.read_ship_type.v1`:

```
EVE_SCOPES=publicData esi-location.read_ship_type.v1
```

Existing users must re-auth at `/eve/login` to grant new scopes.
`/eve/me/ship` will return `403` with a specific hint message if the
scope is missing.

## ESI politeness

The client respects everything CCP asks for:

- `User-Agent: eve-pds/0.1.0 (<your-email>; +https://github.com/) ...`
  built from `EVE_CONTACT_EMAIL`. This is required, not optional.
- `X-ESI-Error-Limit-Remain` / `X-ESI-Error-Limit-Reset` tracked
  process-wide (error limit is per-IP, so one shared state is correct).
  Calls are refused before hitting 0 remaining.
- `420` responses park the window until reset.
- `Expires` and `Last-Modified` headers are returned to callers in the
  response envelope so they can schedule appropriately. We do not yet
  cache on our side — caller responsibility.
- `If-None-Match` / `304` supported via optional `etag` param.

## Character transfers

EVE characters can be sold on the Character Bazaar. The SSO JWT's
`owner` claim changes when this happens. On re-auth, if the stored
`owner` differs from the new one, we **refuse** to issue a session.
The previous owner's atproto repo is not handed to the new owner.
An admin can unlock this manually via direct DB access.

## Setup

1. Register an EVE third-party app at
   https://developers.eveonline.com/applications
   - Callback URL: `https://your-pds.example.com/eve/callback`
   - Scopes: at minimum `publicData`

2. Copy `.env.example` → `.env`, fill in every `REPLACE_ME`.
   ```
   openssl rand --hex 16        # for PDS_JWT_SECRET, PDS_ADMIN_PASSWORD,
                                # PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX
   openssl rand -base64 32      # for EVE_TOKEN_ENCRYPTION_KEY
   ```

3. Install and run:
   ```
   pnpm install
   pnpm build
   pnpm start
   ```

4. TLS-terminating reverse proxy in front (nginx/caddy/cloudflared),
   serving `PDS_HOSTNAME` on :443 to `PDS_PORT`.

## Testing

```bash
# Kick off the SSO flow (browser)
open https://your-pds.example.com/eve/login

# After callback returns JSON, save the accessJwt and hit:
curl -H "Authorization: Bearer $ATP_ACCESS_JWT" \
     https://your-pds.example.com/eve/me/ship
```

## File layout

```
src/
  index.ts            entry point, boots PDS + mounts routes
  config.ts           env parsing + encryption key validation
  identity.ts         EVE character types + handle slugification
  eve-sso.ts          OAuth client: PKCE, token exchange, refresh, JWT verify
  crypto.ts           AES-256-GCM envelope for tokens at rest
  state-store.ts      in-memory OAuth state (TTL 10m)
  character-store.ts  sqlite: character_id <-> DID mapping
  token-store.ts      sqlite (encrypted): EVE access + refresh tokens
  provision.ts        create-or-resolve atproto account + persist EVE tokens
  esi-client.ts       ESI fetcher: auto-refresh, error-limit, cache headers
  routes.ts           /eve/login, /eve/callback, /eve/me/ship + blockers
```

## Known gaps

- **`/eve/me/ship` decodes but does not verify the atproto JWT signature.**
  Fine for read-only data the user could fetch from ESI directly, not
  fine for anything that writes. Hook into the PDS's own auth verifier
  before adding write-ish endpoints.
- **No background polling.** Token storage is in place so polling can be
  added without schema changes — add a scheduler module that reads from
  `eve_token`, calls `callEsi`, writes to a new state table.
- **No OAuth-provider integration for modern atproto clients.** Bluesky
  app etc. will use legacy session tokens via the returned JSON. For
  first-class OAuth support, the PDS's own authorize endpoint needs to
  delegate to EVE.
- **Key rotation for `EVE_TOKEN_ENCRYPTION_KEY` is not implemented.**
  Rotating = everyone re-auths. A future version could dual-key during a
  migration window.

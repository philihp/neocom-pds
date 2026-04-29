# Edencom Social

> "CONCORD has authorized this PDS. Your compliance is mandatory."
> — nobody at CONCORD, actually

An [ATProto](https://atproto.com) Personal Data Server for capsuleers who have
decided that New Eden's local channels aren't enough and they'd like to yell
into the Bluesky void as their immortal pod-piloting alter ego.

One EVE character = one Bluesky account. That's it. That's the deal. CCP is
the identity provider now, whether they intended to be or not.

---

## What This Is

You authenticate with EVE Online SSO. We take your character, slugify your
name into a handle (sorry, Aaäa Aaäson — you're getting the numeric suffix),
spin up an ATProto account on the embedded PDS, slap your portrait on it, and
hand you credentials you can actually use to log into Bluesky.

Your EVE character *is* your Bluesky account. Your birth year is offset by
1898 years so your Bluesky profile shows when you were born in New Eden
instead of whenever CCP's servers first saw you. This is the kind of
attention to detail you get when a game has 20 years of lore to work with.

The whole thing is two services bolted together with express middleware and
a handful of SQLite databases:

- **`src/`** — the PDS backend. Runs `@atproto/pds` embedded, wraps it with
  EVE SSO routes, ESI calls, and enough Supabase auth plumbing to let the
  web frontend talk to it securely.
- **`web/`** — a Next.js frontend. You log in, link your character, set a
  password, and get told which credentials to plug into whatever Bluesky
  client you prefer.

---

## Architecture

```
  browser                  web (Next.js)              PDS backend (Express)
     │                          │                              │
     │  sign up / log in        │                              │
     │─────────────────────────▶│  Supabase anon session       │
     │                          │─────────────────────────────▶│ POST /eve/start-binding
     │◀─────────────────────────│              { url: <EVE SSO redirect> }
     │                          │                              │
     │  redirect to EVE SSO ────────────────────────────────────────────▶ login.eveonline.com
     │◀──────────────────────────────────────────────────────────────── GET /eve/callback
     │                          │                              │
     │                          │              exchange code, verify JWT
     │                          │              create/resolve ATProto account
     │                          │              encrypt + store EVE tokens
     │                          │              bind Supabase user to character
     │                          │                              │
     │  redirect to web ────────────────────────────────────────▶│
     │                          │  set password, finalize      │
     │─────────────────────────▶│                              │
     │                          │  POST /eve/transfer-binding  │
     │                          │─────────────────────────────▶│ (anon → real Supabase user)
     │                          │                              │
     │ done. go login to bsky.  │                              │
```

After onboarding your handle resolves via wildcard DNS — Bluesky fetches
`https://<yourhandle.pds-hostname>/.well-known/atproto-did`, we serve the
bare DID back, everybody's happy.

---

## What Gets Stored

Three side databases alongside the PDS's own data dir:

| DB | What's in it |
|----|-------------|
| `eve-characters.sqlite` | `character_id → (did, handle, owner, name)`. The `owner` hash detects Character Bazaar transfers. If someone buys your character they don't get your Bluesky repo — they get a 403 and a strongly-worded error message. |
| `eve-tokens.sqlite` | Encrypted EVE access + refresh tokens. AES-256-GCM. Rotating `EVE_TOKEN_ENCRYPTION_KEY` logs everyone out simultaneously, which is a great way to clear a room. |
| `users.sqlite` | Supabase user ↔ character binding. This is how the web frontend knows which portrait to show you. |

Refresh tokens rotate — EVE's v2 endpoint may return a new refresh token on
every use and immediately invalidate the old one. The token store writes the
new token before surfacing the new access token to the caller. If the write
fails, you get an error, not a silently broken state. This was not an
accident.

---

## Flow Details

### First login (new character)

1. `/eve/start-binding` — frontend calls this with a Supabase bearer token.
   We generate a PKCE verifier + state, stash them in memory (10-minute TTL),
   and return the EVE SSO URL.
2. User authorizes at `login.eveonline.com`.
3. `/eve/callback` — CCP sends `code` + `state` back. We exchange for tokens,
   verify the JWT via CCP's JWKS endpoint, and provision an ATProto account
   if one doesn't exist yet. Portrait gets fetched from EVE's image server and
   uploaded to the PDS blob store. EVE tokens get encrypted and stored.
4. Supabase anon session gets bound to the character. User returns to the web
   app, sets a password, and we upgrade the anon session to a real one.

### Re-login (existing character)

Same SSO flow, but instead of creating an account we call
`com.atproto.admin.updateAccountPassword` with a freshly-generated random
password, then immediately log in with it. The random password is discarded.
There is no stored password. This is intentional and not a bug.

### Handle changes

`/eve/start-handle-change` kicks off a fresh SSO round-trip to confirm you
still own the character, then calls `com.atproto.identity.updateHandle` on
your behalf. You can't change your handle via a direct ATProto call — we
block `com.atproto.identity.updateHandle` from external clients because
otherwise someone could just... ask us to change it without proving anything.

### Logging in from a native ATProto client (e.g. the Bluesky app)

`POST /xrpc/com.atproto.server.createSession` is intercepted. We look up your
handle/DID, find the Supabase account bound to it, fetch your email, validate
your password against Supabase, then do the admin password-reset trick to mint
a fresh session. Loopback calls (from the PDS itself during provisioning) skip
all of this and fall through to the native handler.

---

## EVE Scopes

`publicData` is the minimum — enough to establish identity, nothing else.

To use the `/eve/me/ship` debug endpoint (returns your current ship type
via ESI), add:

```
EVE_SCOPES=publicData esi-location.read_ship_type.v1
```

Existing users need to re-auth at `/eve/login` to grant new scopes. If the
scope is missing, you get a `403` with a hint instead of a silent failure.

---

## ESI Politeness

We do not want to be banned by CCP. To that end:

- `User-Agent` is set to include your `EVE_CONTACT_EMAIL`. CCP requires this.
  It is not optional. Please fill it in.
- `X-ESI-Error-Limit-Remain` / `X-ESI-Error-Limit-Reset` are tracked
  process-wide (the limit is per-IP, so one shared counter is correct).
  Calls are refused before the limit hits 0.
- `420` responses park the call until the reset window expires.
- `Expires` and `Last-Modified` from ESI are forwarded to callers so they
  can schedule their own retries appropriately.

---

## Character Transfers

EVE characters can be sold on the Character Bazaar. The `owner` hash in the
SSO JWT changes when this happens. If a re-auth shows a new owner, we refuse
to issue a session. The previous owner's ATProto repo is not transferred.

To unlock a transferred character, an admin must update the `owner` column
directly in `eve-characters.sqlite`. There is no automated path for this
because automated paths are how you get scammed.

---

## File Layout

```
src/
  index.ts            entry, boots PDS + mounts all routers
  config.ts           env parsing, encryption key validation
  identity.ts         re-exports from @edencom/character-slug (handle slugging)
  eve-sso.ts          PKCE, token exchange, token refresh, JWKS JWT verify
  crypto.ts           AES-256-GCM token encryption at rest
  state-store.ts      in-memory OAuth state (TTL 10 min)
  character-store.ts  sqlite: character_id ↔ DID/handle/owner
  token-store.ts      sqlite (encrypted): EVE access + refresh tokens
  user-store.ts       sqlite: Supabase user ↔ character binding
  provision.ts        create-or-resolve ATProto account, set EVE profile
  esi-client.ts       ESI fetcher: auto-refresh, error-limit, cache headers
  supabase-auth.ts    Supabase bearer token validation + email/password checks
  routes.ts           all HTTP handlers

web/
  app/page.tsx        landing + onboarding UI (Next.js, Supabase auth)
  app/actions.ts      server actions: startBinding, finishBinding, cancelBinding

packages/
  character-slug/     shared handle-slugification logic (workspace package)
```

---

## Setup

1. Register an EVE third-party app at
   https://developers.eveonline.com/applications
   - Callback URL: `https://your-pds.example.com/eve/callback`
   - Scopes: at minimum `publicData`

2. Copy `.env.example` → `.env` and fill in every `REPLACE_ME`.

   ```bash
   openssl rand --hex 16      # PDS_JWT_SECRET, PDS_ADMIN_PASSWORD,
                              # PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX
   openssl rand -base64 32    # EVE_TOKEN_ENCRYPTION_KEY
   ```

3. Set up a Supabase project. The web app needs `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`.
   The PDS backend needs `SUPABASE_URL` and `SUPABASE_SECRET_KEY`.

4. Install and run:

   ```bash
   pnpm install
   pnpm build
   pnpm start
   ```

5. Put a TLS-terminating reverse proxy in front (nginx, Caddy, Cloudflare).
   `PDS_HOSTNAME` must be on port 443. Wildcard DNS (`*.pds-hostname`) pointing
   at the server enables subdomain handle verification.

6. Deploy `web/` to Vercel or wherever Next.js apps go to live. Set
   `PDS_API_URL` to point at your PDS backend.

---

## Known Gaps

- **`/eve/me/ship` does not verify the ATProto JWT signature.** Fine for
  read-only ESI data the user could fetch themselves. Not fine before adding
  anything write-adjacent. The PDS's own auth verifier needs to be wired in
  first.
- **No background ESI polling.** The token storage schema supports it — add a
  scheduler that reads from `eve_token`, calls `callEsi`, writes to a new
  state table. Nobody has done this yet.
- **No first-class ATProto OAuth.** The Bluesky app uses legacy session
  tokens via the intercepted `createSession` endpoint. First-class OAuth would
  require the PDS's own authorize endpoint to delegate to EVE SSO. This is on
  the list somewhere between "would be nice" and "maybe someday."
- **`EVE_TOKEN_ENCRYPTION_KEY` rotation is not implemented.** Rotating the
  key invalidates all stored tokens simultaneously. A migration window with
  dual-key support would fix this. For now: don't rotate the key unless you
  enjoy support requests.

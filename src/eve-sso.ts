import * as R from "ramda";
import * as crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { EveConfig } from "./config.js";
import type { EveCharacter } from "./identity.js";

const SSO_BASE = "https://login.eveonline.com";
const METADATA_URL = `${SSO_BASE}/.well-known/oauth-authorization-server`;
const AUTHORIZE_URL = `${SSO_BASE}/v2/oauth/authorize`;
const TOKEN_URL = `${SSO_BASE}/v2/oauth/token`;
const VALID_ISSUERS = ["login.eveonline.com", "https://login.eveonline.com"];
const EXPECTED_AUDIENCE = "EVE Online";

// --- PKCE helpers ----------------------------------------------------------

const base64url = (buf: Buffer): string =>
  buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const generateCodeVerifier = (): string =>
  base64url(crypto.randomBytes(32));

export const codeChallengeFor: (verifier: string) => string = R.pipe(
  (v: string) => crypto.createHash("sha256").update(v).digest(),
  base64url,
);

// --- Authorization URL -----------------------------------------------------

export interface AuthorizeParams {
  readonly state: string;
  readonly codeChallenge: string;
}

export const buildAuthorizeUrl = R.curry(
  (cfg: EveConfig, params: AuthorizeParams): string => {
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: cfg.clientId,
      redirect_uri: cfg.callbackUrl,
      scope: cfg.scopes.join(" "),
      state: params.state,
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
    });
    return `${AUTHORIZE_URL}?${qs.toString()}`;
  },
);

// --- Token exchange --------------------------------------------------------

export interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
  readonly token_type: string;
}

const basicAuth = (clientId: string, clientSecret: string): string =>
  "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

export const exchangeCodeForToken = async (
  cfg: EveConfig,
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> => {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(cfg.clientId, cfg.clientSecret),
      Host: "login.eveonline.com",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`EVE token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as TokenResponse;
};

/**
 * Exchange a refresh token for a new access token (and possibly a new
 * refresh token - v2 tokens CAN rotate on refresh).
 *
 * Throws TokenRefreshError on 4xx - the caller should treat this as
 * permanent and mark the stored token as invalidated. Transient 5xx /
 * network errors throw generic Errors which the caller may retry.
 */
export class TokenRefreshError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "TokenRefreshError";
  }
}

export const refreshAccessToken = async (
  cfg: EveConfig,
  refreshToken: string,
): Promise<TokenResponse> => {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(cfg.clientId, cfg.clientSecret),
      Host: "login.eveonline.com",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status >= 400 && res.status < 500) {
      throw new TokenRefreshError(
        `EVE refresh rejected (${res.status})`,
        res.status,
        text,
      );
    }
    throw new Error(`EVE refresh failed (${res.status}): ${text}`);
  }
  return (await res.json()) as TokenResponse;
};

// --- JWT verification ------------------------------------------------------

interface SsoMetadata {
  readonly jwks_uri: string;
}

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

const loadJwks = async () => {
  if (cachedJwks) return cachedJwks;
  const metaRes = await fetch(METADATA_URL);
  if (!metaRes.ok) throw new Error("Failed to load EVE SSO metadata");
  const meta = (await metaRes.json()) as SsoMetadata;
  cachedJwks = createRemoteJWKSet(new URL(meta.jwks_uri));
  return cachedJwks;
};

// EVE's sub claim is "CHARACTER:EVE:<id>"
const parseCharacterId = (sub: unknown): number => {
  if (typeof sub !== "string") throw new Error("JWT sub must be a string");
  const match = sub.match(/^CHARACTER:EVE:(\d+)$/);
  if (!match) throw new Error(`Unexpected sub format: ${sub}`);
  return Number(match[1]);
};

const ensureValidIssuer = (iss: unknown): void => {
  if (typeof iss !== "string" || !VALID_ISSUERS.includes(iss)) {
    throw new Error(`Invalid issuer: ${String(iss)}`);
  }
};

const ensureValidAudience = (aud: unknown, clientId: string): void => {
  const list = Array.isArray(aud) ? aud : [aud];
  if (!list.includes(clientId)) {
    throw new Error("Token audience missing client_id");
  }
  if (!list.includes(EXPECTED_AUDIENCE)) {
    throw new Error('Token audience missing "EVE Online"');
  }
};

interface EveJwtPayload extends JWTPayload {
  readonly name?: string;
  readonly owner?: string;
  readonly scp?: string | ReadonlyArray<string>;
}

export const verifyAccessToken = async (
  cfg: EveConfig,
  accessToken: string,
): Promise<EveCharacter> => {
  const jwks = await loadJwks();
  // jose handles signature + exp; we handle iss/aud ourselves because
  // EVE issues tokens with either host or URL form of the issuer.
  const { payload } = await jwtVerify(accessToken, jwks);
  const p = payload as EveJwtPayload;

  ensureValidIssuer(p.iss);
  ensureValidAudience(p.aud, cfg.clientId);

  const characterId = parseCharacterId(p.sub);
  const characterName = typeof p.name === "string" ? p.name : null;
  const owner = typeof p.owner === "string" ? p.owner : null;
  if (!characterName || !owner) {
    throw new Error("JWT missing name/owner claims");
  }
  return { characterId, characterName, owner };
};

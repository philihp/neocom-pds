import * as R from 'ramda'

export interface EveConfig {
  readonly clientId: string
  readonly clientSecret: string
  readonly callbackUrl: string
  readonly scopes: ReadonlyArray<string>
  readonly contactEmail: string
}

export interface AppConfig {
  readonly hostname: string;
  readonly serviceHandleDomains: string;
  readonly port: number;
  readonly eve: EveConfig;
  readonly tokenEncryptionKey: Buffer;
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
  readonly supabaseSecretKey: string;
  readonly webAppUrl: string;
}

const required = (key: string): string => {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required env var: ${key}`)
  return value
}

const splitScopes: (s: string) => ReadonlyArray<string> = R.pipe(
  R.split(/\s+/),
  R.reject(R.isEmpty),
)

const parseEncryptionKey = (b64: string): Buffer => {
  const buf = Buffer.from(b64, 'base64')
  if (buf.length !== 32) {
    throw new Error(
      'EVE_TOKEN_ENCRYPTION_KEY must be 32 bytes base64 ' +
        '(generate with: openssl rand -base64 32)',
    )
  }
  return buf
}

export const loadConfig = (): AppConfig => ({
  hostname: required("PDS_HOSTNAME"),
  serviceHandleDomains:
    process.env.PDS_SERVICE_HANDLE_DOMAINS ?? `.${process.env.PDS_HOSTNAME}`,
  port: Number(process.env.PDS_PORT || process.env.PORT || "2583"),
  eve: {
    clientId: required("EVE_CLIENT_ID"),
    clientSecret: required("EVE_CLIENT_SECRET"),
    callbackUrl: required("EVE_CALLBACK_URL"),
    scopes: splitScopes(required("EVE_SCOPES")),
    contactEmail: required("EVE_CONTACT_EMAIL"),
  },
  tokenEncryptionKey: parseEncryptionKey(required("EVE_TOKEN_ENCRYPTION_KEY")),
  supabaseUrl: required("SUPABASE_URL"),
  supabaseAnonKey: required("SUPABASE_ANON_KEY"),
  supabaseSecretKey: required("SUPABASE_SECRET_KEY"),
  webAppUrl: required("WEB_APP_URL"),
});

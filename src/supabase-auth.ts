interface SupabaseUser {
  readonly id: string
  readonly email?: string
}

interface SupabaseGetUserResponse {
  readonly id?: string
  readonly email?: string
  readonly message?: string // present on error
}

export const extractSupabaseUser = async (
  authorizationHeader: string | undefined,
  supabaseUrl: string,
  supabaseSecretKey: string,
): Promise<string | null> => {
  if (!authorizationHeader?.startsWith('Bearer ')) return null
  const token = authorizationHeader.slice('Bearer '.length)

  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: supabaseSecretKey,
    },
  })

  if (!res.ok) return null

  const body = (await res.json()) as SupabaseGetUserResponse
  return body.id ?? null
}

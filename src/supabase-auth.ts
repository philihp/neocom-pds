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

export const getSupabaseUserEmail = async (
  userId: string,
  supabaseUrl: string,
  supabaseSecretKey: string,
): Promise<string | null> => {
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    headers: {
      Authorization: `Bearer ${supabaseSecretKey}`,
      apikey: supabaseSecretKey,
    },
  })
  if (!res.ok) return null
  const body = (await res.json()) as SupabaseGetUserResponse
  return body.email ?? null
}

export const validateSupabasePassword = async (
  email: string,
  password: string,
  supabaseUrl: string,
  supabaseSecretKey: string,
): Promise<boolean> => {
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseSecretKey,
    },
    body: JSON.stringify({ email, password }),
  })
  return res.ok
}

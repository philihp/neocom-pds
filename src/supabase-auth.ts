import { createClient } from '@supabase/supabase-js'

const makeAdminClient = (supabaseUrl: string, supabaseSecretKey: string) =>
  createClient(supabaseUrl, supabaseSecretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

export const extractSupabaseUser = async (
  authorizationHeader: string | undefined,
  supabaseUrl: string,
  supabaseSecretKey: string,
): Promise<string | null> => {
  if (!authorizationHeader?.startsWith('Bearer ')) return null
  const token = authorizationHeader.slice('Bearer '.length)

  const supabase = createClient(supabaseUrl, supabaseSecretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return data.user.id
}

export const getSupabaseUserEmail = async (
  userId: string,
  supabaseUrl: string,
  supabaseSecretKey: string,
): Promise<string | null> => {
  const supabase = makeAdminClient(supabaseUrl, supabaseSecretKey)
  const { data, error } = await supabase.auth.admin.getUserById(userId)
  if (error || !data.user) return null
  return data.user.email ?? null
}

export const validateSupabasePassword = async (
  email: string,
  password: string,
  supabaseUrl: string,
  supabaseSecretKey: string,
): Promise<boolean> => {
  const supabase = makeAdminClient(supabaseUrl, supabaseSecretKey)
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    console.error(`[supabase-auth] password validation failed for ${email}: ${error.message}`)
  }
  return !error
}

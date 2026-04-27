'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export const startAnonymousBinding = async () => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    const { error } = await supabase.auth.signInAnonymously()
    if (error) throw new Error(`Anonymous sign-in failed: ${error.message}`)
  }

  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) throw new Error('No session after anonymous sign-in')

  const pdsUrl = process.env.PDS_API_URL
  if (!pdsUrl) throw new Error('PDS_API_URL not configured')

  const res = await fetch(`${pdsUrl}/eve/start-binding`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}` },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to start EVE binding: ${text}`)
  }

  const { url } = (await res.json()) as { url: string }
  redirect(url)
}

'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { slugifyCharacterName } from '@edencom/character-slug'

export const startEveBinding = async () => {
  const supabase = await createClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session) {
    redirect('/login')
  }

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

export const signOut = async () => {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/')
}

export const completeAccount = async (formData: FormData) => {
  const password = formData.get('password')
  const confirm = formData.get('confirm')

  if (typeof password !== 'string' || typeof confirm !== 'string') {
    redirect('/dashboard?account_error=Invalid+request')
  }
  if (password !== confirm) {
    redirect('/dashboard?account_error=Passwords+do+not+match')
  }
  if (password.length < 8) {
    redirect('/dashboard?account_error=Password+must+be+at+least+8+characters')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) redirect('/')

  const pdsUrl = process.env.PDS_API_URL
  if (!pdsUrl) throw new Error('PDS_API_URL not configured')

  const accountRes = await fetch(`${pdsUrl}/api/account`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
    cache: 'no-store',
  })
  if (!accountRes.ok) {
    redirect('/dashboard?account_error=Could+not+verify+EVE+binding')
  }
  const account = (await accountRes.json()) as {
    bound: boolean
    characterId?: number
    characterName?: string
  }
  if (!account.bound || !account.characterId || !account.characterName) {
    redirect('/dashboard?account_error=Link+your+EVE+character+first')
  }

  const email = `${slugifyCharacterName(account.characterName)}@edencom.link`

  const { error } = await supabase.auth.updateUser({ email, password })
  if (error) {
    redirect(`/dashboard?account_error=${encodeURIComponent(error.message)}`)
  }

  redirect('/dashboard?account_created=true')
}

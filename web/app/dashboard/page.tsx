import Image from 'next/image'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { startEveBinding, signOut } from './actions'

interface AccountData {
  bound: boolean
  characterId?: number
  handle?: string
  did?: string
}

const fetchAccount = async (accessToken: string): Promise<AccountData> => {
  const pdsUrl = process.env.PDS_API_URL
  if (!pdsUrl) return { bound: false }

  try {
    const res = await fetch(`${pdsUrl}/api/account`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    })
    if (!res.ok) return { bound: false }
    return res.json() as Promise<AccountData>
  } catch (err) {
    console.error('fetchAccount failed:', err)
    return { bound: false }
  }
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ eve_bound?: string; eve_error?: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const {
    data: { session },
  } = await supabase.auth.getSession()

  const account = session ? await fetchAccount(session.access_token) : { bound: false }
  const params = await searchParams
  const justBound = params.eve_bound === 'true'
  const bindingError = params.eve_error

  return (
    <main>
      <h1>Your Account</h1>

      {justBound && (
        <fieldset>
          <legend>Success</legend>EVE character successfully linked to your account.
        </fieldset>
      )}
      {bindingError && (
        <fieldset>
          <legend>Failed</legend>
          {bindingError}
        </fieldset>
      )}

      <p>
        You are logged in as <var>{user.email}</var>
      </p>

      <form action={signOut} style={{ display: 'inline' }}>
        <button type="submit">Sign Out</button>
      </form>

      <h2>EVE Online Identity</h2>

      {account.bound ? (
        <div>
          <Image
            src={`https://images.evetech.net/characters/${account.characterId}/portrait?size=64`}
            alt={account.handle ?? 'Character portrait'}
            width={64}
            height={64}
          />
          <dl>
            <dt>Handle</dt>
            <dd>
              <var>{account.handle}</var>
            </dd>
            <dt>Character ID</dt>
            <dd>
              <var>{account.characterId}</var>
            </dd>
            <dt>DID</dt>
            <dd>
              <var>
                <code>{account.did}</code>
              </var>
            </dd>
          </dl>
          <p>
            To re-link a different character, use the button below. This will replace your
            current binding.
          </p>
          <form action={startEveBinding}>
            <button type="submit">Switch Character</button>
          </form>
        </div>
      ) : (
        <div>
          <p>
            No EVE character linked yet. Connect your pilot to get your AT Protocol handle
            and join the network.
          </p>
          <form action={startEveBinding}>
            <button type="submit">Connect EVE Identity</button>
          </form>
        </div>
      )}
    </main>
  )
}

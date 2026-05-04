import Image from 'next/image'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { startBinding, cancelBinding } from './actions'
import { PasswordForm } from './PasswordForm'

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

export default async function LandingPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const {
    data: { session },
  } = await supabase.auth.getSession()

  const pdsUrl = process.env.PDS_API_URL
  if (!pdsUrl) throw new Error('PDS_API_URL not configured')

  const account = session && (await fetchAccount(session.access_token))

  return (
    <>
      <main>
        <section>
          <h1>Edencom Social Link</h1>

          {user && user.is_anonymous && (
            <fieldset>
              <legend>Handle Selection</legend>
              <PasswordForm
                characterId={account!.characterId!}
                handle={account!.handle!}
                pdsUrl={pdsUrl}
              />
            </fieldset>
          )}

          {user && !user.is_anonymous && (
            <>
              <fieldset>
                <legend>Link</legend>
                <Image
                  src={`https://images.evetech.net/characters/${account!.characterId}/portrait?size=256`}
                  alt={account?.handle ?? 'Character portrait'}
                  width={128}
                  height={128}
                />
                <dl>
                  <dt>Host</dt>
                  <dd>
                    <code>{pdsUrl}</code>
                  </dd>
                  <dt>Username</dt>
                  <dd>
                    <Link href={`https://bsky.app/profile/${account?.handle}`}>
                      {account?.handle}
                    </Link>
                  </dd>
                  <dt>Password</dt>
                  <dd>
                    <var>**************************</var>
                  </dd>
                </dl>
              </fieldset>
              <p>
                Your New Eden identity is secured. Specify this host as a custom hosting
                provider to use it when connecting to apps like{' '}
                <Link href="http://bsky.app">Bluesky</Link>.
              </p>
            </>
          )}

          {!user && (
            <>
              <p>
                Claim your Edencom social credentials with your New Eden identity for{' '}
                <Link href="https://atproto.com">AT Proto</Link> clients like Bluesky.
              </p>
              <form action={startBinding}>
                <button type="submit">Connect</button>
              </form>
            </>
          )}

          {/* <pre>{JSON.stringify({ user, session, account }, undefined, 2)}</pre> */}
        </section>
        {user && (
          <form action={cancelBinding}>
            <button type="submit" className="secondary">
              Disconnect
            </button>
          </form>
        )}
      </main>
    </>
  )
}

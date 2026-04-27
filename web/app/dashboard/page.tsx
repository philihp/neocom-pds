import Image from 'next/image'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { startEveBinding, signOut, completeAccount } from './actions'
import { startAnonymousBinding } from '../actions'

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
  searchParams: Promise<{
    eve_bound?: string
    eve_error?: string
    account_created?: string
    account_error?: string
  }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/')

  const {
    data: { session },
  } = await supabase.auth.getSession()

  const account = session ? await fetchAccount(session.access_token) : { bound: false }
  const params = await searchParams
  const justBound = params.eve_bound === 'true'
  const bindingError = params.eve_error
  const accountCreated = params.account_created === 'true'
  const accountError = params.account_error

  const isAnonymous = user.is_anonymous === true

  if (isAnonymous && !account.bound) {
    return (
      <main>
        <h1>Step through the gate</h1>
        {bindingError && (
          <fieldset>
            <legend>Failed</legend>
            {bindingError}
          </fieldset>
        )}
        <p>
          To get started, connect through EVE Online to bring your capsuleer across.
          We&apos;ll forge your AT Protocol handle from your character&apos;s name.
        </p>
        <form action={startAnonymousBinding}>
          <button type="submit">Connect through EVE Online</button>
        </form>
      </main>
    )
  }

  if (isAnonymous && account.bound) {
    return (
      <main>
        <h1>Set a Password</h1>

        {justBound && (
          <fieldset>
            <legend>Success</legend>EVE character successfully linked.
          </fieldset>
        )}

        <h2>Your EVE Character</h2>
        <Image
          src={`https://images.evetech.net/characters/${account.characterId}/portrait?size=128`}
          alt={account.handle ?? 'Character portrait'}
          width={128}
          height={128}
        />
        <dl>
          <dt>Handle</dt>
          <dd>
            <var>{account.handle}</var>
          </dd>
          <dt>DID</dt>
          <dd>
            <var>
              <code>{account.did}</code>
            </var>
          </dd>
        </dl>

        <p>
          Choose a password to finish creating your account. You&apos;ll use it to sign in
          on Bluesky and other AT Protocol clients.
        </p>

        <form action={completeAccount}>
          <p>
            <label htmlFor="password">
              Password
              <br />
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="new-password"
                minLength={8}
              />
            </label>
          </p>
          <p>
            <label htmlFor="confirm">
              Confirm Password
              <br />
              <input
                id="confirm"
                name="confirm"
                type="password"
                required
                autoComplete="new-password"
                minLength={8}
              />
            </label>
          </p>
          {accountError && (
            <p>
              <strong>Error:</strong> {accountError}
            </p>
          )}
          <button type="submit">Create Account</button>
        </form>
      </main>
    )
  }

  return (
    <main>
      <h1>Your Account</h1>

      {accountCreated && (
        <fieldset>
          <legend>Account Created</legend>You can now sign in to the PDS with your handle
          and password.
        </fieldset>
      )}
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
            src={`https://images.evetech.net/characters/${account.characterId}/portrait?size=128`}
            alt={account.handle ?? 'Character portrait'}
            width={128}
            height={128}
          />
          <dl>
            <dt>Handle</dt>
            <dd>
              <var>
                <Link href={`http://bsky.app/profile/${account.handle}`}>
                  {account.handle}
                </Link>
              </var>
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

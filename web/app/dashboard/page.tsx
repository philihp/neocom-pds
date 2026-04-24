import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { startEveBinding, signOut } from './actions'
import styles from './dashboard.module.css'

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
    <main className={styles.main}>
      <header className={styles.header}>
        <span className={styles.logo}>Edencom Social</span>
        <form action={signOut}>
          <button type="submit" className={styles.signOutBtn}>
            Sign Out
          </button>
        </form>
      </header>

      <div className={styles.content}>
        <section className={styles.section}>
          <h1 className={styles.title}>Your Account</h1>
          <p className={styles.email}>{user.email}</p>
        </section>

        {justBound && (
          <div className={styles.banner} data-variant="success">
            EVE character successfully linked to your account.
          </div>
        )}

        {bindingError && (
          <div className={styles.banner} data-variant="error">
            EVE binding failed: {bindingError}
          </div>
        )}

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>EVE Online Identity</h2>

          {account.bound ? (
            <div className={styles.characterCard}>
              <div className={styles.characterInfo}>
                <span className={styles.characterLabel}>Handle</span>
                <span className={styles.characterValue}>
                  @{account.handle}
                </span>
              </div>
              <div className={styles.characterInfo}>
                <span className={styles.characterLabel}>Character ID</span>
                <span className={styles.characterValue}>
                  {account.characterId}
                </span>
              </div>
              <div className={styles.characterInfo}>
                <span className={styles.characterLabel}>DID</span>
                <code className={styles.did}>{account.did}</code>
              </div>
              <p className={styles.hint}>
                To re-link a different character, use the button below. This
                will replace your current binding.
              </p>
              <form action={startEveBinding}>
                <button type="submit" className={styles.rebindBtn}>
                  Switch Character
                </button>
              </form>
            </div>
          ) : (
            <div className={styles.emptyCard}>
              <p>
                No EVE character linked yet. Connect your pilot to get your AT
                Protocol handle and join the network.
              </p>
              <form action={startEveBinding}>
                <button type="submit" className={styles.bindBtn}>
                  Connect EVE Character
                </button>
              </form>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}

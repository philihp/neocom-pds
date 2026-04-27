import Link from 'next/link'
import { startAnonymousBinding } from './actions'

export default function LandingPage() {
  return (
    <main>
      <h1>Edencom Social</h1>
      <p>
        AT Protocol capsuleer identity registery. The identities of New Eden citizens have
        been validated by the edencom.link PDS.
      </p>

      <ol>
        <li>
          <strong>Step through the gate</strong> &mdash; Connect through EVE Online to
          bring your capsuleer across into the real world. Your handle is forged from your
          character&apos;s name.
        </li>
        <li>
          <strong>Claim your account</strong> &mdash; Once your character is linked,
          choose a password to claim your account.
        </li>
        <li>
          <strong>Sign in</strong> &mdash; Connect to the Edencom PDS on{' '}
          <Link href="https://bsky.app/">Bluesky</Link> or any{' '}
          <Link href="https://techcrunch.com/2025/06/13/beyond-bluesky-these-are-the-apps-building-social-experiences-on-the-at-protocol/">
            AT Protocol client
          </Link>
          .
        </li>
      </ol>

      <form action={startAnonymousBinding}>
        <button type="submit">Connect through EVE Online</button>
      </form>
    </main>
  )
}

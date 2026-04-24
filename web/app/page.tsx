import Link from 'next/link'

export default function LandingPage() {
  return (
    <main>
      <h1>Edencom Social</h1>
      <p>
        AT Protocol capsuleer identity registery. The identities of New Eden citizens have
        been validated by the edencom.link PDS.
      </p>
      <p>
        [ <Link href="/signup">Create Account</Link> | <Link href="/login">Sign In</Link>{' '}
        ]
      </p>

      <hr />

      <ol>
        <li>
          <strong>
            <Link href="/signup">Create an account</Link>
          </strong>{' '}
          &mdash; This is what you'll use to login to the Edencom PDS.
        </li>
        <li>
          <strong>Bind your pilot</strong> &mdash; Link your capsuleer identity via EVE
          Online SSO. Your handle will be is generated from your character&apos;s name.
        </li>
        <li>
          <strong>Sign in</strong> &mdash; to the Edencom PDS with your account on{' '}
          <Link href="https://bsky.app/">Bluesky</Link> or any{' '}
          <Link href="https://techcrunch.com/2025/06/13/beyond-bluesky-these-are-the-apps-building-social-experiences-on-the-at-protocol/">
            AT Protocol client
          </Link>
          .
        </li>
      </ol>
    </main>
  )
}

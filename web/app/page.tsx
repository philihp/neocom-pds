import Link from 'next/link'
import styles from './page.module.css'

export default function LandingPage() {
  return (
    <main className={styles.main}>
      <div className={styles.hero}>
        <h1 className={styles.title}>Neocom PDS</h1>
        <p className={styles.tagline}>
          Your AT Protocol Personal Data Server, forged in New Eden.
        </p>
        <p className={styles.description}>
          Create an account, connect your EVE Online pilot, and own your
          presence on the decentralized web.
        </p>
        <div className={styles.actions}>
          <Link href="/signup" className={styles.btnPrimary}>
            Create Account
          </Link>
          <Link href="/login" className={styles.btnSecondary}>
            Sign In
          </Link>
        </div>
      </div>

      <section className={styles.steps}>
        <div className={styles.step}>
          <span className={styles.stepNumber}>1</span>
          <h2>Create an account</h2>
          <p>Sign up with your email and a password. Takes seconds.</p>
        </div>
        <div className={styles.step}>
          <span className={styles.stepNumber}>2</span>
          <h2>Bind your pilot</h2>
          <p>
            Authorize via EVE Online SSO to link your character. Your AT Protocol
            handle is generated from your character&apos;s name.
          </p>
        </div>
        <div className={styles.step}>
          <span className={styles.stepNumber}>3</span>
          <h2>Join the network</h2>
          <p>
            Your data lives on your own PDS. Use any AT Protocol client to post,
            connect, and explore.
          </p>
        </div>
      </section>
    </main>
  )
}

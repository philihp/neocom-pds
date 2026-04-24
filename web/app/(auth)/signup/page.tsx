'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Turnstile } from '@/components/Turnstile'
import styles from '../auth.module.css'

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY!

export default function SignupPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (!captchaToken) {
      setError('Please complete the captcha.')
      return
    }

    setLoading(true)
    const supabase = createClient()
    const { error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        // captchaToken,
      },
    })

    if (authError) {
      setError(
        authError.message ||
          'Sign up failed. Check that your email is valid and try again.',
      )
      setLoading(false)
      return
    }

    setDone(true)
    setLoading(false)
  }

  if (done) {
    return (
      <main className={styles.main}>
        <div className={styles.card}>
          <h1 className={styles.title}>Check your inbox</h1>
          <p className={styles.subtitle}>
            We sent a confirmation link to <strong>{email}</strong>. Click it to activate
            your account, then come back to sign in.
          </p>
          <Link href="/login" className={styles.link}>
            Back to sign in
          </Link>
        </div>
      </main>
    )
  }

  return (
    <main className={styles.main}>
      <div className={styles.card}>
        <h1 className={styles.title}>Create Account</h1>
        <p className={styles.subtitle}>
          Already have one? <Link href="/login">Sign in</Link>
        </p>

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="pilot@example.com"
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              placeholder="••••••••"
              minLength={8}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="confirm">Confirm Password</label>
            <input
              id="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
              placeholder="••••••••"
            />
          </div>
          <Turnstile
            siteKey={TURNSTILE_SITE_KEY}
            onSuccess={setCaptchaToken}
            onExpire={() => setCaptchaToken(null)}
            options={{ theme: 'dark' }}
          />
          {error && <p className={styles.error}>{error}</p>}
          <button
            type="submit"
            className={styles.submit}
            disabled={loading || !captchaToken}
          >
            {loading ? 'Creating account…' : 'Create Account'}
          </button>
        </form>
      </div>
    </main>
  )
}

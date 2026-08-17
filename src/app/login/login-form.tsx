'use client'

import Link from 'next/link'
import { useState } from 'react'
import { isValidEmail } from '@/lib/validation'
import { login } from './actions'

export function LoginForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    let hasError = false

    if (!email.trim()) {
      setEmailError('Email is required.')
      hasError = true
    } else if (!isValidEmail(email)) {
      setEmailError('Enter a valid email address.')
      hasError = true
    }

    if (!password) {
      setPasswordError('Password is required.')
      hasError = true
    }

    if (hasError) return

    setLoading(true)
    const formData = new FormData(e.currentTarget)
    const result = await login(formData)

    if (result?.error) {
      setError(result.error)
      setLoading(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="flex w-full max-w-[392px] flex-col gap-[26px] rounded-frame border border-border-subtle bg-bg-surface px-[34px] pt-9 pb-xl shadow-card"
    >
      <div className="flex flex-col gap-xs">
        <div className="flex items-center gap-[9px]">
          <span className="block h-4 w-4 rounded-[3px] bg-accent" />
          <span className="text-body font-medium tracking-micro text-text-primary">
            Reelcraft
          </span>
        </div>
        <h1 className="mt-[14px] text-title font-medium tracking-snug text-text-primary">
          Sign in
        </h1>
        <p className="text-ui text-text-secondary">
          Pick up where your last project stopped.
        </p>
      </div>

      <div className="flex flex-col gap-md">
        <label htmlFor="email" className="flex flex-col gap-2xs">
          <span className="text-meta text-text-secondary">Email</span>
          <input
            id="email"
            name="email"
            type="email"
            required
            placeholder="ana@studio.co"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              setEmailError(null)
            }}
            aria-invalid={emailError ? true : undefined}
            className={`h-[38px] rounded-badge border bg-bg-surface px-[11px] text-control text-text-primary outline-none focus:shadow-focus-halo ${
              emailError ? 'border-status-failed-fg' : 'border-border-strong focus:border-accent'
            }`}
          />
          {emailError && <span className="text-chip text-status-failed-fg">{emailError}</span>}
        </label>
        <label htmlFor="password" className="flex flex-col gap-2xs">
          <span className="text-meta text-text-secondary">Password</span>
          <input
            id="password"
            name="password"
            type="password"
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              setPasswordError(null)
            }}
            aria-invalid={passwordError ? true : undefined}
            className={`h-[38px] rounded-badge border bg-bg-surface px-[11px] text-control text-text-primary outline-none focus:shadow-focus-halo ${
              passwordError ? 'border-status-failed-fg' : 'border-border-strong focus:border-accent'
            }`}
          />
          {passwordError && (
            <span className="text-chip text-status-failed-fg">{passwordError}</span>
          )}
        </label>
      </div>

      {error && <p className="text-small text-status-failed-fg">{error}</p>}

      <div className="flex flex-col gap-[14px]">
        <button
          type="submit"
          disabled={loading}
          className="h-10 w-full rounded-control border border-accent bg-transparent text-control font-medium text-accent outline-none hover:bg-accent-wash focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:border-accent-active active:bg-accent-wash-strong active:text-accent-active disabled:opacity-[.45]"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="flex items-center justify-between text-small">
          <span className="text-text-secondary">
            No account?{' '}
            <Link
              href="/signup"
              className="rounded-badge text-accent outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Create one
            </Link>
          </span>
          <span className="text-text-tertiary">Forgot password</span>
        </div>
      </div>
    </form>
  )
}

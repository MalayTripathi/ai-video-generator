'use client'

import Link from 'next/link'
import { useState } from 'react'
import { isValidEmail } from '@/lib/validation'
import { signup } from './actions'

export function SignupForm() {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [agreed, setAgreed] = useState(false)

  const [fullNameError, setFullNameError] = useState<string | null>(null)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [confirmPasswordError, setConfirmPasswordError] = useState<string | null>(null)
  const [termsError, setTermsError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    let hasError = false

    if (!fullName.trim()) {
      setFullNameError('Name is required.')
      hasError = true
    }

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
    } else if (password.length < 6) {
      setPasswordError('Password must be at least 6 characters.')
      hasError = true
    }

    if (!confirmPassword) {
      setConfirmPasswordError('Please confirm your password.')
      hasError = true
    } else if (password !== confirmPassword) {
      setConfirmPasswordError('Passwords do not match.')
      hasError = true
    }

    if (!agreed) {
      setTermsError('Please agree to the terms to continue.')
      hasError = true
    }

    if (hasError) return

    setLoading(true)
    const formData = new FormData(e.currentTarget)
    const result = await signup(formData)

    if (result?.error) {
      setError(result.error)
      setLoading(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="flex w-full max-w-[392px] flex-col gap-[26px] rounded-frame border border-border-subtle bg-bg-surface px-[34px] pt-9 pb-rc-xl shadow-card"
    >
      <div className="flex flex-col gap-rc-xs">
        <div className="flex items-center gap-[9px]">
          <span className="block h-4 w-4 rounded-[3px] bg-accent" />
          <span className="text-body font-medium tracking-micro text-text-primary">
            Reelcraft
          </span>
        </div>
        <h1 className="mt-[14px] text-title font-medium tracking-snug text-text-primary">
          Create an account
        </h1>
        <p className="text-ui text-text-secondary">
          A few fields, then your first topic.
        </p>
      </div>

      <div className="flex flex-col gap-rc-md">
        <label htmlFor="fullName" className="flex flex-col gap-rc-2xs">
          <span className="text-meta text-text-secondary">Name</span>
          <input
            id="fullName"
            name="fullName"
            type="text"
            required
            placeholder="Ana Kovač"
            value={fullName}
            onChange={(e) => {
              setFullName(e.target.value)
              setFullNameError(null)
            }}
            aria-invalid={fullNameError ? true : undefined}
            className={`h-[38px] rounded-badge border bg-bg-surface px-[11px] text-control text-text-primary outline-none focus:shadow-focus-halo ${
              fullNameError
                ? 'border-status-failed-fg'
                : 'border-border-strong focus:border-accent'
            }`}
          />
          {fullNameError && (
            <span className="text-chip text-status-failed-fg">{fullNameError}</span>
          )}
        </label>
        <label htmlFor="email" className="flex flex-col gap-rc-2xs">
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
        <label htmlFor="password" className="flex flex-col gap-rc-2xs">
          <span className="text-meta text-text-secondary">Password</span>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              setPasswordError(null)
            }}
            aria-invalid={passwordError ? true : undefined}
            className={`h-[38px] rounded-badge border bg-bg-surface px-[11px] text-control text-text-primary outline-none focus:shadow-focus-halo ${
              passwordError
                ? 'border-status-failed-fg'
                : 'border-border-strong focus:border-accent'
            }`}
          />
          {passwordError && (
            <span className="text-chip text-status-failed-fg">{passwordError}</span>
          )}
        </label>
        <label htmlFor="confirmPassword" className="flex flex-col gap-rc-2xs">
          <span className="text-meta text-text-secondary">Confirm password</span>
          <input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            required
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value)
              setConfirmPasswordError(null)
            }}
            aria-invalid={confirmPasswordError ? true : undefined}
            className={`h-[38px] rounded-badge border bg-bg-surface px-[11px] text-control text-text-primary outline-none focus:shadow-focus-halo ${
              confirmPasswordError
                ? 'border-status-failed-fg'
                : 'border-border-strong focus:border-accent'
            }`}
          />
          {confirmPasswordError && (
            <span className="text-chip text-status-failed-fg">{confirmPasswordError}</span>
          )}
        </label>
      </div>

      <div className="flex flex-col gap-rc-2xs">
        <label className="flex cursor-pointer items-start gap-[10px]">
          <input
            type="checkbox"
            name="terms"
            checked={agreed}
            onChange={(e) => {
              setAgreed(e.target.checked)
              setTermsError(null)
            }}
            aria-invalid={termsError ? true : undefined}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className={`mt-px flex h-4 w-4 flex-none items-center justify-center rounded-badge border text-accent outline-none peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent ${
              termsError
                ? 'border-status-failed-fg bg-bg-surface'
                : agreed
                  ? 'border-accent bg-accent-wash'
                  : 'border-border-strong bg-bg-surface'
            }`}
          >
            {agreed && (
              <svg width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true">
                <path d="M1 4.25 3.5 6.75 9 1.25" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            )}
          </span>
          <span className="text-meta leading-[1.5] text-text-secondary">
            I agree to the <span className="text-accent">terms of service</span> and the{' '}
            <span className="text-accent">privacy policy</span>.
          </span>
        </label>
        {termsError && <span className="text-chip text-status-failed-fg">{termsError}</span>}
      </div>

      {error && <p className="text-small text-status-failed-fg">{error}</p>}

      <div className="flex flex-col gap-[14px]">
        <button
          type="submit"
          disabled={loading}
          className="h-10 w-full rounded-control border border-accent bg-transparent text-control font-medium text-accent outline-none hover:bg-accent-wash focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:border-accent-active active:bg-accent-wash-strong active:text-accent-active disabled:opacity-[.45]"
        >
          {loading ? 'Creating account…' : 'Create account'}
        </button>
        <div className="flex items-center justify-center text-small">
          <span className="text-text-secondary">
            Already have an account?{' '}
            <Link
              href="/login"
              className="rounded-badge text-accent outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Sign in
            </Link>
          </span>
        </div>
      </div>
    </form>
  )
}

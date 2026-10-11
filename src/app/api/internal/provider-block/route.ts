import { NextResponse } from 'next/server'
import { isProduction } from '@/lib/config/env'
import { providerGuardEnv } from '@/lib/config/env.server'
import { ALLOW_FLAG, providerCallsBlocked } from '@/lib/providers/live-call-guard'

// Vercel Hobby caps a function at 300s; tests/route-max-duration.spec.ts enforces it.
export const maxDuration = 300

// Whether this server refuses every provider call. tests/global-setup.ts asks before a run
// starts, so a suite can never drive a server that could make a live call - including a dev
// server on :3000 that Playwright reused rather than started. Two booleans, no values; not
// served on preview or production.
export function GET() {
  if (isProduction()) return new NextResponse(null, { status: 404 })
  const env = providerGuardEnv()
  return NextResponse.json({
    blocked: providerCallsBlocked(env),
    optOutsEmpty: Object.values(ALLOW_FLAG).every((flag) => !env[flag]),
  })
}

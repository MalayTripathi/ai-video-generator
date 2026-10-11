import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getBalance } from '@/lib/credits/balance'
import { recordFixedSpend } from '@/lib/credits/ledger'
import { tryLoadRailFigures } from '@/app/(app)/rail-figures'
import { loadImageStatuses } from './logic'

// Vercel Hobby caps a function at 300s; tests/route-max-duration.spec.ts enforces it.
export const maxDuration = 300

// Polled by the Storyboard page for per-shot image state (ready / stale / queued /
// generating / failed / not generated), with freshly signed image URLs on every call. A
// plain JSON read - never router.refresh().
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

  const result = await loadImageStatuses({ supabase, projectId, userId: user.id, getBalance, recordFixedSpend })
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status })
  // The rail's spend figures ride on every status read; the page applies them when a poll
  // shows a shot has settled (its charge lands at settle).
  const rail = await tryLoadRailFigures(user.id)
  return NextResponse.json({ ok: true, ...result.data, rail }, { status: 200 })
}

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { SHOT_RUN_LEDGER } from '../schedule'
import { loadShotsStatus } from './logic'

// Vercel Hobby caps a function at 300s; tests/route-max-duration.spec.ts enforces it.
export const maxDuration = 300

// Polled by the Workbench while shots are being written - a plain JSON read, never
// router.refresh(). Two round trips: the user, then one embedded read.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

  const result = await loadShotsStatus({ supabase, projectId, userId: user.id, ledger: SHOT_RUN_LEDGER })
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true, ...result.data }, { status: 200 })
}

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { loadShotList } from './logic'

// Vercel Hobby caps a function at 300s; tests/route-max-duration.spec.ts enforces it.
export const maxDuration = 300

// Read by the Workbench once a shot run ends - the shot list and the run's end state, never
// router.refresh(). Two round trips: the user, then three reads in one wave.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

  const result = await loadShotList({ supabase, projectId, userId: user.id })
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true, ...result.data }, { status: 200 })
}

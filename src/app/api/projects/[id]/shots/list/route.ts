import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { tryLoadRailFigures } from '@/app/(app)/rail-figures'
import { loadShotList } from './logic'

// Vercel Hobby caps a function at 300s; tests/route-max-duration.spec.ts enforces it.
export const maxDuration = 300

// Read by the Workbench once a shot run ends - everything the run changed on the page, and
// the rail's figures with its settle in them - never router.refresh(). Three round trips: the
// user, then one wave (the list's reads and the rail's two), then the elements' signing.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

  const [result, rail] = await Promise.all([loadShotList({ supabase, projectId, userId: user.id }), tryLoadRailFigures(user.id)])
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true, ...result.data, rail }, { status: 200 })
}

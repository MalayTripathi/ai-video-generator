import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { loadImageStatuses } from './logic'

// Polled by the Storyboard page for per-shot image state (ready / stale / queued /
// generating / failed / not generated). A plain JSON read - never router.refresh().
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

  const result = await loadImageStatuses({ supabase, projectId, userId: user.id })
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true, ...result.data }, { status: 200 })
}

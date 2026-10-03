// Cancel a queued export. A row the worker has already claimed is refused (409).
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { cancelExport } from '../../logic'

// Vercel Hobby caps a function at 300s; tests/route-max-duration.spec.ts enforces it.
export const maxDuration = 300

export async function POST(_request: Request, { params }: { params: Promise<{ id: string; exportId: string }> }) {
  const { id: projectId, exportId } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const result = await cancelExport({ supabase, projectId, userId: user.id, exportId })
  if (result.ok) return NextResponse.json({ ok: true, data: result.data }, { status: result.status })
  return NextResponse.json({ ok: false, error: result.error }, { status: result.status })
}

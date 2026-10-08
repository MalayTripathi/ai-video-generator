import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createExport, loadExports } from './logic'

// Vercel Hobby caps a function at 300s; tests/route-max-duration.spec.ts enforces it.
export const maxDuration = 300

// The export history (GET, polled only while an export is queued or rendering) and
// "Export slideshow" (POST). Export is free: no balance gate.

async function session() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return { supabase, user }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params
  const { supabase, user } = await session()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const result = await loadExports({ supabase, projectId, userId: user.id })
  if (result.ok) return NextResponse.json({ ok: true, ...result.data }, { status: 200 })
  return NextResponse.json({ ok: false, error: result.error }, { status: result.status })
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params
  const { supabase, user } = await session()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const result = await createExport({ supabase, projectId, userId: user.id })
  if (result.ok) return NextResponse.json({ ok: true, data: result.data }, { status: result.status })
  return NextResponse.json({ ok: false, error: result.error }, { status: result.status })
}

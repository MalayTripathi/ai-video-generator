import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { uploadReferenceImageForUser, removeReferenceImageForUser } from '@/lib/elements/reference'

// sharp is a native binary and cannot run on the Edge runtime.
export const runtime = 'nodejs'

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; elementId: string }> }
) {
  const { id: projectId, elementId } = await params

  // Rejected before the body is touched at all - the one check that runs before any
  // body-consuming call.
  const contentLength = Number(request.headers.get('content-length'))
  if (!Number.isFinite(contentLength) || contentLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ success: false, error: 'File exceeds 8 MB limit' }, { status: 413 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid form data' }, { status: 400 })
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 })
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ success: false, error: 'File exceeds 8 MB limit' }, { status: 413 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const result = await uploadReferenceImageForUser(supabase, projectId, elementId, user.id, buffer)

  return NextResponse.json(result, { status: result.success ? 200 : 400 })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; elementId: string }> }
) {
  const { id: projectId, elementId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }

  const result = await removeReferenceImageForUser(supabase, projectId, elementId, user.id)

  return NextResponse.json(result, { status: result.success ? 200 : 400 })
}

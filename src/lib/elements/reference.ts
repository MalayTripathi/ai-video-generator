import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import type { createClient } from '@/lib/supabase/server'
import { loadOwnedElement } from '@/lib/elements/write'
import { markImagePromptsStaleForElementReference } from '@/lib/elements/staleness'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
const MAX_DIMENSION = 1024
const WEBP_QUALITY = 82
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp'])
const SIGNED_URL_EXPIRES_IN_SECONDS = 3600

export type ReferenceUploadResult =
  | { success: true; path: string; url: string }
  | { success: false; error: string }

export type ReferenceRemoveResult = { success: true } | { success: false; error: string }

// The only input is the buffer's own bytes - there is no filename or declared-mimetype
// parameter anywhere in this pipeline, so a mislabeled extension/Content-Type can never
// reach a decision here. Format is read via sharp/libvips's own content sniffing.
async function normalizeReferenceImage(
  input: Buffer
): Promise<{ success: true; buffer: Buffer } | { success: false; error: string }> {
  let format: string | undefined
  try {
    format = (await sharp(input).metadata()).format
  } catch {
    return { success: false, error: 'Could not read image' }
  }

  if (!format || !ALLOWED_FORMATS.has(format)) {
    return { success: false, error: 'Unsupported image type - use JPEG, PNG, or WebP' }
  }

  // .rotate() bakes in EXIF orientation before metadata is dropped; no .withMetadata()
  // call means the re-encoded output carries no EXIF/ICC/GPS at all.
  const buffer = await sharp(input)
    .rotate()
    .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer()

  return { success: true, buffer }
}

export type UploadReferenceObjectResult = { success: true; path: string } | { success: false; error: string }

// The storage-only half of a reference upload: normalize + write to a fresh,
// randomUUID()-suffixed path (the artifacts bucket's storage.objects RLS grants
// select/insert/delete but no update, so every write is insert-only by construction -
// there is no in-place overwrite to attempt). No DB write, no signing, no old-object
// cleanup - callers with different sequencing needs (a plain manual upload vs. a
// claimed AI generation that must persist a generations payload BETWEEN the storage
// write and the elements row update) each do their own next steps on top of this.
export async function uploadNormalizedReferenceObject(
  supabase: SupabaseServerClient,
  userId: string,
  projectId: string,
  elementId: string,
  fileBuffer: Buffer
): Promise<UploadReferenceObjectResult> {
  const normalized = await normalizeReferenceImage(fileBuffer)
  if (!normalized.success) return normalized

  const path = `${userId}/${projectId}/elements/${elementId}/${randomUUID()}.webp`

  const { error } = await supabase.storage
    .from('artifacts')
    .upload(path, normalized.buffer, { contentType: 'image/webp', upsert: false })
  if (error) return { success: false, error: error.message }

  return { success: true, path }
}

// Best-effort old-object cleanup, shared by every replacement path (manual upload,
// manual removal, AI generation/regeneration) - logs and swallows rather than failing
// the caller, since by the time this runs the element row already points at something
// valid (or nothing), and the orphaned object is a cleanup concern, not a correctness one.
async function removeReferenceObject(supabase: SupabaseServerClient, path: string): Promise<void> {
  const { error } = await supabase.storage.from('artifacts').remove([path])
  if (error) {
    console.error(`[elements] Failed to remove reference image ${path}:`, error.message)
  }
}

// Replacing an existing reference writes the new object and updates the element row
// before removing the old object, so a failure part-way always leaves the element
// pointing at something real.
export async function uploadReferenceImageForUser(
  supabase: SupabaseServerClient,
  projectId: string,
  elementId: string,
  userId: string,
  fileBuffer: Buffer
): Promise<ReferenceUploadResult> {
  if (fileBuffer.byteLength > MAX_UPLOAD_BYTES) {
    return { success: false, error: 'File exceeds 8 MB limit' }
  }

  const element = await loadOwnedElement(supabase, elementId, userId)
  if (!element || element.project_id !== projectId) {
    return { success: false, error: 'Element not found' }
  }

  const uploaded = await uploadNormalizedReferenceObject(supabase, userId, projectId, elementId, fileBuffer)
  if (!uploaded.success) return uploaded

  const { error: dbError } = await supabase
    .from('elements')
    .update({ reference_image_path: uploaded.path })
    .eq('id', elementId)
  if (dbError) {
    // The new object is now orphaned - tolerated per spec. The element row is untouched,
    // so it still points at whatever was valid before this call (possibly nothing).
    return { success: false, error: dbError.message }
  }

  await markImagePromptsStaleForElementReference(supabase, projectId, elementId, element.type)

  const { data: signed, error: signError } = await supabase.storage
    .from('artifacts')
    .createSignedUrl(uploaded.path, SIGNED_URL_EXPIRES_IN_SECONDS)
  if (signError || !signed) {
    return { success: false, error: signError?.message ?? 'Failed to sign uploaded image' }
  }

  if (element.reference_image_path) {
    await removeReferenceObject(supabase, element.reference_image_path)
  }

  return { success: true, path: uploaded.path, url: signed.signedUrl }
}

// The DB path is cleared before the storage object is removed, mirroring the upload
// ordering above: the element reaches a valid state (no reference) before anything it
// used to point at is deleted.
export async function removeReferenceImageForUser(
  supabase: SupabaseServerClient,
  projectId: string,
  elementId: string,
  userId: string
): Promise<ReferenceRemoveResult> {
  const element = await loadOwnedElement(supabase, elementId, userId)
  if (!element || element.project_id !== projectId) {
    return { success: false, error: 'Element not found' }
  }

  if (!element.reference_image_path) return { success: true }

  const { error: dbError } = await supabase
    .from('elements')
    .update({ reference_image_path: null })
    .eq('id', elementId)
  if (dbError) return { success: false, error: dbError.message }

  await markImagePromptsStaleForElementReference(supabase, projectId, elementId, element.type)
  await removeReferenceObject(supabase, element.reference_image_path)

  return { success: true }
}

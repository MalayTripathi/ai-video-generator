import { redirect } from 'next/navigation'

// TODO(2026-08-27): remove this redirect once bookmarked /script URLs have died down (~1 week)
export default async function ScriptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/projects/${id}/workbench`)
}

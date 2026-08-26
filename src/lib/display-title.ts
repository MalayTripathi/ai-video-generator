const FALLBACK_LENGTH = 60

export function displayTitle(project: { title: string | null; source_text: string | null }): string {
  if (project.title) return project.title

  const source = project.source_text?.trim()
  if (!source) return 'Untitled project'

  return source.length > FALLBACK_LENGTH ? `${source.slice(0, FALLBACK_LENGTH).trimEnd()}…` : source
}

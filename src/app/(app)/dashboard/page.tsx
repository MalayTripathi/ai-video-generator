import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth/current-user'
import { ProjectGrid } from './project-grid'
import { SearchButton, TopBar } from './top-bar'
import type { Project } from './types'

export default async function DashboardPage() {
  const supabase = await createClient()
  const user = await getCurrentUser()

  if (!user) {
    redirect('/login')
  }

  const { data: projects } = await supabase
    .from('projects')
    .select('id, title, source_text, status, current_step, created_at, video_type, aspect_ratio, furthest_step, shots(count)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  // shots(count) is one indexed count per project, returned in this same round trip -
  // PostgREST aggregates are disabled here, so a grouped count would return every shot row.
  const cards: Project[] = (projects ?? []).map(({ shots, ...project }) => ({
    ...project,
    shot_count: shots[0]?.count ?? 0,
  }))

  return (
    <>
      <TopBar
        left={
          <h1 className="text-screen font-medium tracking-tight text-text-primary">
            Your projects
          </h1>
        }
        right={<SearchButton />}
      />
      <ProjectGrid projects={cards} />
    </>
  )
}

import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth/current-user'
import { WorkbenchShell } from '@/components/workbench-shell'
import { ProjectHeader } from '@/components/workbench/project-header'
import { loadAgentMessages } from '@/lib/load-agent-messages'
import { stepIndex } from '@/lib/config/pipeline'
import { ASPECT_RATIOS, type AspectRatio } from '@/lib/config/enums'
import { getBalance } from '@/lib/credits/balance'
import { loadImageStatuses, IMAGE_STATUS_PROJECT_COLUMNS } from '@/app/api/projects/[id]/images/status/logic'
import { loadExports, type ExportsData } from '@/app/api/projects/[id]/exports/logic'
import { STATUS_POLL_INTERVAL_MS } from '@/lib/config/storyboard'
import { StoryboardProvider } from './_components/storyboard-context'
import { PlaybackProvider } from './_components/playback-context'
import { StoryboardMain } from './_components/storyboard-main'
import { InspectPanel } from './_components/inspect-panel'
import { StoryboardFooter } from './_components/storyboard-footer'
import { STORYBOARD_SHOT_COLUMNS } from './_components/types'

// Step 4: the timeline with live images (canvas 15). The picture lane and inspect panel
// read real data; the audio lanes, preview and export are drawn static until built. The
// first paint reads image state here, server-side, with the same function the status
// endpoint polls - so nothing flashes and nothing is fetched on load.
export default async function StoryboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params

  const supabase = await createClient()
  const user = await getCurrentUser()

  if (!user) {
    redirect('/login')
  }

  // One project read serves the page and the image-status first paint (its voiceover and
  // music lanes), so loadImageStatuses doesn't re-read it.
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select(
      `id, title, source_text, current_step, furthest_step, video_type, language, video_model, video_resolution, quality_preset, duration_target, mix_voice_gain_db, mix_music_gain_db, mix_duck_depth_db, mix_duck_bypass, music_style_prompt, export_motion, export_transition, caption_mode, caption_style, caption_position, loudness_preset, ${IMAGE_STATUS_PROJECT_COLUMNS}`
    )
    .eq('id', projectId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (projectError) {
    throw new Error(`Could not load project ${projectId}: ${projectError.message}`)
  }
  if (!project) {
    notFound()
  }

  // View-gate, not an edit-lock: a project whose furthest_step hasn't reached the
  // storyboard yet must not see it - same rule as Step 3's own page.
  if (project.furthest_step < stepIndex('storyboard')) {
    redirect(`/projects/${projectId}/${project.current_step}`)
  }

  // Everything below needs only the verified project, not each other - one wave. The agent
  // history numbers turns by shot, so it waits on the shots read inside its own chain.
  // A real Promise (not the query builder), so the two consumers share one execution.
  const shotsPromise = Promise.resolve(
    supabase.from('shots').select(STORYBOARD_SHOT_COLUMNS).eq('project_id', projectId).order('order_index', { ascending: true })
  ).then(({ data }) => data ?? [])
  const [shots, status, exportsResult, agentMessages] = await Promise.all([
    shotsPromise,
    loadImageStatuses({ supabase, projectId, userId: user.id, getBalance, project }),
    // Export history's first paint, from the same function its poll reads.
    loadExports({ supabase, projectId, userId: user.id, projectVerified: true }),
    loadAgentMessages(supabase, projectId, shotsPromise),
  ])
  if (!status.ok) {
    if (status.status === 404) notFound()
    throw new Error(status.error)
  }
  const exportsData: ExportsData = exportsResult.ok ? exportsResult.data : { rows: [], pollIntervalMs: STATUS_POLL_INTERVAL_MS }

  const aspectRatio: AspectRatio = (ASPECT_RATIOS as readonly string[]).includes(project.aspect_ratio)
    ? (project.aspect_ratio as AspectRatio)
    : '9:16'

  return (
    <StoryboardProvider
      projectId={projectId}
      aspectRatio={aspectRatio}
      // Never frozen: the Storyboard stays editable after the project advances to Video Prompts.
      readOnly={false}
      initialShots={shots}
      initialStatus={status.data}
      initialMix={{
        mix_voice_gain_db: project.mix_voice_gain_db,
        mix_music_gain_db: project.mix_music_gain_db,
        mix_duck_depth_db: project.mix_duck_depth_db,
        mix_duck_bypass: project.mix_duck_bypass,
        music_muted: project.music_muted,
      }}
      initialExportSettings={{
        export_motion: project.export_motion,
        export_transition: project.export_transition,
        caption_mode: project.caption_mode,
        caption_style: project.caption_style,
        caption_position: project.caption_position,
        loudness_preset: project.loudness_preset,
      }}
    >
      <PlaybackProvider>
        <WorkbenchShell
          project={project}
          agentStep="storyboard"
          agentMessages={agentMessages}
          shots={shots}
          header={<ProjectHeader project={project} shots={shots} />}
          footer={<StoryboardFooter furthestStep={project.furthest_step} />}
          sideColumn={<InspectPanel />}
        >
          <StoryboardMain
            language={project.language}
            initialExports={exportsData}
            initialMusicStylePrompt={project.music_style_prompt}
          />
        </WorkbenchShell>
      </PlaybackProvider>
    </StoryboardProvider>
  )
}

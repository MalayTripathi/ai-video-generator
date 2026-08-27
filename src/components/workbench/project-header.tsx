import { durationConfig, type DurationTarget } from '@/lib/config/duration'
import { videoTypeLabel } from '@/lib/video-type-labels'
import { languageLabel } from '@/lib/language-labels'
import { displayTitle } from '@/lib/display-title'

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function LockIcon() {
  return (
    <svg width="9" height="11" viewBox="0 0 10 12" fill="none" aria-hidden="true">
      <rect x="0.75" y="4.9" width="8.5" height="6.35" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.75 4.9V3.3a2.25 2.25 0 0 1 4.5 0v1.6" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function Chip({ children, accent = false }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span
      className={
        accent
          ? 'flex items-center gap-[5px] rounded-full border border-accent-faint px-[10px] py-1 text-chip text-accent'
          : 'flex items-center gap-[5px] rounded-full border border-border-strong px-[10px] py-1 text-chip text-text-secondary'
      }
    >
      {children}
    </span>
  )
}

export function ProjectHeader({
  project,
  shots,
}: {
  project: {
    title: string | null
    source_text: string | null
    video_type: string | null
    aspect_ratio: string | null
    language: string | null
    video_model: string | null
    duration_target: string | null
  }
  shots: { duration_sec: number | null; duration_locked: boolean }[]
}) {
  const targetLabel =
    project.duration_target && project.duration_target in durationConfig
      ? durationConfig[project.duration_target as DurationTarget].label
      : null

  const totalSeconds = shots.reduce((sum, shot) => sum + (shot.duration_sec ?? 0), 0)
  const lockedCount = shots.filter((shot) => shot.duration_locked).length

  return (
    <div className="flex flex-col gap-rc-sm">
      <div className="flex items-baseline justify-between gap-rc-lg">
        <h3 className="truncate text-title font-medium tracking-snug text-text-primary">
          {displayTitle(project)}
        </h3>
        <div className="flex flex-none items-center gap-rc-xs text-meta">
          {targetLabel && (
            <>
              <span className="text-text-tertiary">Target</span>
              <span className="font-medium">{targetLabel}</span>
              <span className="text-text-quiet">·</span>
            </>
          )}
          <span className="text-text-tertiary">Current</span>
          <span className="font-medium">
            {shots.length} shots · {formatDuration(totalSeconds)}
          </span>
          {lockedCount > 0 && (
            <>
              <span className="text-text-quiet">·</span>
              <span className="flex items-center gap-1 text-text-secondary">
                <LockIcon />
                {lockedCount} locked
              </span>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-rc-2xs">
        {videoTypeLabel(project.video_type) && <Chip>{videoTypeLabel(project.video_type)}</Chip>}
        {project.aspect_ratio && <Chip>{project.aspect_ratio} · locked</Chip>}
        {languageLabel(project.language) && <Chip>{languageLabel(project.language)}</Chip>}
        {project.video_model && <Chip accent>{project.video_model}</Chip>}
      </div>
    </div>
  )
}

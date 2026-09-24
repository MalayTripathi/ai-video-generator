import Link from 'next/link'
import { displayTitle } from '@/lib/display-title'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { PROGRESS_STEP_COUNT, progressStepLabel } from '@/lib/config/pipeline'
import { videoTypeLabel } from '@/lib/video-type-labels'
import type { Project } from './types'

const stripeStyle = {
  backgroundImage: 'repeating-linear-gradient(135deg, var(--stripe-a) 0 7px, var(--stripe-b) 7px 14px)',
}

function StripeThumbnail() {
  return (
    <div className="flex aspect-video items-center justify-center rounded-badge" style={stripeStyle}>
      <span className="font-mono text-mono text-text-tertiary">Preview pending</span>
    </div>
  )
}

function WellThumbnail() {
  return (
    <div className="flex aspect-video items-center justify-center rounded-badge border border-dashed border-border-muted bg-bg-well">
      <span className="font-mono text-mono text-text-tertiary">No stills yet</span>
    </div>
  )
}

function FailedThumbnail() {
  return <div className="aspect-video rounded-badge border border-status-failed-line bg-status-failed-bg" />
}

// 'auto' is replaced by the detected type at shot generation; one still 'auto' is omitted.
function detailLine(project: Project): string {
  const type = project.video_type && project.video_type !== 'auto' ? videoTypeLabel(project.video_type) : null
  const shots = project.shot_count > 0 ? `${project.shot_count} ${project.shot_count === 1 ? 'shot' : 'shots'}` : null
  return [type, shots, project.aspect_ratio].filter(Boolean).join(' · ')
}

// Fill count comes from furthest_step alone, fill colour from status alone - never mixed.
function ProgressBar({ filled, status }: { filled: number; status: string }) {
  const fillClass =
    status === 'completed' ? 'bg-status-done-fg' : status === 'in_progress' ? 'bg-status-active-fg' : 'bg-status-draft-fg'
  return (
    <div className="flex gap-[3px]" aria-hidden="true">
      {Array.from({ length: PROGRESS_STEP_COUNT }, (_, i) => (
        <div
          key={i}
          data-testid="progress-segment"
          data-filled={i < filled}
          className={`h-[3px] flex-1 rounded-full ${i < filled ? fillClass : 'bg-border-subtle'}`}
        />
      ))}
    </div>
  )
}

export function ProjectCard({ project }: { project: Project }) {
  const timeLabel = formatRelativeTime(project.created_at)
  const title = displayTitle(project)
  // furthest_step clamped to the progress scale - the one source for both the badge's
  // step number and the progress bar's fill count.
  const progressStep = Math.min(Math.max(project.furthest_step, 1), PROGRESS_STEP_COUNT)

  let thumbnail: React.ReactNode
  let badge: React.ReactNode
  let footer: React.ReactNode

  switch (project.status) {
    case 'completed':
      thumbnail = <StripeThumbnail />
      badge = (
        <span className="rounded-badge bg-status-done-bg px-rc-xs py-rc-3xs text-chip font-medium text-status-done-fg">
          Complete
        </span>
      )
      footer = <span className="text-meta text-text-tertiary">{timeLabel}</span>
      break

    case 'in_progress':
      thumbnail = <StripeThumbnail />
      badge = (
        <span className="rounded-badge bg-status-active-bg px-rc-xs py-rc-3xs text-chip font-medium text-status-active-fg">
          Step {progressStep} of {PROGRESS_STEP_COUNT} · {progressStepLabel(progressStep)}
        </span>
      )
      footer = <span className="text-meta text-text-tertiary">{timeLabel}</span>
      break

    case 'failed':
      thumbnail = <FailedThumbnail />
      badge = (
        <span className="rounded-badge bg-status-failed-bg px-rc-xs py-rc-3xs text-chip font-medium text-status-failed-fg">
          Render failed
        </span>
      )
      footer = <span className="text-small font-medium text-accent">Try again</span>
      break

    case 'draft':
    default:
      thumbnail = <WellThumbnail />
      badge = (
        <span className="rounded-badge bg-status-draft-bg px-rc-xs py-rc-3xs text-chip font-medium text-text-secondary">
          Draft
        </span>
      )
      footer = <span className="text-meta text-text-tertiary">{timeLabel}</span>
      break
  }

  return (
    <Link
      href={`/projects/${project.id}/${project.current_step}`}
      className="flex flex-col gap-rc-sm rounded-control border border-border-subtle bg-bg-surface p-rc-sm pb-[14px] shadow-card hover:border-border-strong hover:shadow-card-hover"
    >
      {thumbnail}
      <div className="flex flex-col gap-[6px]">
        <div className="flex flex-col gap-[2px]">
          <div className="truncate text-body font-medium tracking-micro text-text-primary">{title}</div>
          <div data-testid="project-card-detail" className="truncate text-chip leading-[16px] text-text-tertiary">
            {detailLine(project)}
          </div>
        </div>
        <div className="flex items-center justify-between">
          {badge}
          {footer}
        </div>
      </div>
      <ProgressBar filled={progressStep} status={project.status} />
    </Link>
  )
}

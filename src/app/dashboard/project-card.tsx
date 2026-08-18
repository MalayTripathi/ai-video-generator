import Link from 'next/link'
import { formatRelativeTime } from '@/lib/format-relative-time'
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

function ResumeIcon() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden="true">
      <path d="M0.75 4.5h8.5M6.25 1.25 9.5 4.5 6.25 7.75" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

export function ProjectCard({ project }: { project: Project }) {
  const timeLabel = formatRelativeTime(project.created_at)
  const title = project.title || 'Untitled project'

  let thumbnail: React.ReactNode
  let badge: React.ReactNode
  let footer: React.ReactNode
  let footerJustify: 'gap' | 'between'

  switch (project.status) {
    case 'completed':
      thumbnail = <StripeThumbnail />
      badge = (
        <span className="rounded-badge bg-status-done-bg px-rc-xs py-rc-3xs text-chip font-medium text-status-done-fg">
          Complete
        </span>
      )
      footer = <span className="text-meta text-text-tertiary">{timeLabel}</span>
      footerJustify = 'gap'
      break

    case 'in_progress':
      thumbnail = <StripeThumbnail />
      badge = (
        <span className="rounded-badge bg-status-active-bg px-rc-xs py-rc-3xs text-chip font-medium text-status-active-fg">
          In progress
        </span>
      )
      footer = (
        <span className="flex items-center gap-[5px] text-small font-medium text-accent">
          Resume
          <ResumeIcon />
        </span>
      )
      footerJustify = 'between'
      break

    case 'failed':
      thumbnail = <FailedThumbnail />
      badge = (
        <span className="rounded-badge bg-status-failed-bg px-rc-xs py-rc-3xs text-chip font-medium text-status-failed-fg">
          Render failed
        </span>
      )
      footer = <span className="text-small font-medium text-accent">Try again</span>
      footerJustify = 'between'
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
      footerJustify = 'gap'
      break
  }

  return (
    <Link
      href={`/projects/${project.id}/${project.current_step}`}
      className="flex flex-col gap-rc-sm rounded-control border border-border-subtle bg-bg-surface p-rc-sm pb-[14px] shadow-card hover:border-border-strong hover:shadow-card-hover"
    >
      {thumbnail}
      <div className="flex flex-col gap-[10px]">
        <div className="truncate text-body font-medium tracking-micro text-text-primary">{title}</div>
        <div className={`flex items-center ${footerJustify === 'between' ? 'justify-between' : 'gap-[10px]'}`}>
          {badge}
          {footer}
        </div>
      </div>
    </Link>
  )
}

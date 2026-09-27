'use client'

import { useState } from 'react'
import type { ExportHistoryRow, ExportsData } from '@/app/api/projects/[id]/exports/logic'
import { CAPTION_POSITIONS, CAPTION_MODES, EXPORT_MOTIONS, LOUDNESS_PRESETS, TRANSITIONS } from '@/lib/config/enums'
import { EXPOSED_CAPTION_STYLES } from '@/lib/config/storyboard'
import {
  CAPTION_MODE_LABELS,
  CAPTION_POSITION_LABELS,
  CAPTION_STYLE_LABELS,
  captionsBurned,
  EXPORT_MOTION_LABELS,
  exportRowSummary,
  exportSummary,
  loudnessLabel,
  TRANSITION_LABELS,
  type ExportSettingColumn,
} from '@/lib/export/settings'
import { formatClockTime } from '@/lib/format-clock-time'
import { CustomSelect } from '../../workbench/_components/custom-select'
import { useStoryboard } from './storyboard-context'
import { useExportsPoll } from './use-exports-poll'

// Export (canvas 15g): the settings (film defaults, captions, loudness), the free "Export
// slideshow" button, and the export history. Rendering happens on the export worker; this
// section queues a job and polls its row only while one is queued or rendering. Free: no
// credits and no balance gate.

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="6"
      viewBox="0 0 9 6"
      fill="none"
      aria-hidden="true"
      className={`flex-none transition-transform ${open ? '' : '-rotate-90'}`}
    >
      <path d="M1 1.25 4.5 4.75 8 1.25" className="stroke-text-tertiary" strokeWidth="1.3" />
    </svg>
  )
}

/** A joined segmented control. `grid` lays the options out in columns of four (Motion). */
function Segmented<T extends string>({
  label,
  options,
  value,
  labels,
  onChange,
  disabled,
  grid,
  fill,
}: {
  label: string
  options: readonly T[]
  value: T
  labels: Record<T, string>
  onChange: (value: T) => void
  disabled?: boolean
  grid?: boolean
  fill?: boolean
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={
        grid
          ? 'grid w-[372px] flex-none grid-cols-4 gap-px overflow-hidden rounded-control border border-border-strong bg-border-subtle'
          : `flex flex-none items-center overflow-hidden rounded-control border border-border-strong ${fill ? 'min-w-[180px]' : ''}`
      }
    >
      {options.map((option, i) => {
        const selected = option === value
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => !selected && onChange(option)}
            className={`flex h-[30px] items-center justify-center whitespace-nowrap text-small disabled:cursor-not-allowed ${
              grid ? 'px-[10px]' : fill ? 'flex-1' : 'px-[11px]'
            } ${!grid && i > 0 ? 'border-l border-border-subtle' : ''} ${
              selected
                ? 'bg-bg-inset font-medium text-text-primary'
                : `${grid ? 'bg-bg-canvas' : ''} cursor-pointer text-text-secondary hover:bg-bg-inset disabled:hover:bg-transparent`
            } ${disabled && !selected ? 'opacity-60' : ''}`}
          >
            {labels[option]}
          </button>
        )
      })}
    </div>
  )
}

function SettingRow({ title, note, children, last }: { title: string; note: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`flex items-center gap-[16px] p-[13px_15px] ${last ? '' : 'border-b border-border-subtle'}`}>
      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="text-ui font-medium">{title}</span>
        <span className="text-meta text-text-tertiary">{note}</span>
      </span>
      {children}
    </div>
  )
}

const selectTrigger =
  'h-[30px] justify-between gap-[10px] rounded-control border border-border-strong bg-bg-canvas px-[11px] text-small hover:border-border-strong-hover disabled:opacity-60'

function ExportSettingsPanel() {
  const { resolvedExport: s, setExportSetting, readOnly, voiceover } = useStoryboard()
  const set = (field: ExportSettingColumn) => (value: string) => void setExportSetting(field, value)
  const hasVoiceover = voiceover.current !== null
  return (
    <div data-testid="export-settings-panel" className="flex flex-col overflow-hidden rounded-frame border border-border-subtle">
      <SettingRow
        title="Motion"
        note="The film-wide default. Alternate cycles push in, pan, pull out, pan, so consecutive shots never repeat a move. Per-shot overrides are set in Motion & transitions mode."
      >
        <Segmented
          label="Motion"
          grid
          options={EXPORT_MOTIONS}
          value={s.motion}
          labels={EXPORT_MOTION_LABELS}
          onChange={set('export_motion')}
          disabled={readOnly}
        />
      </SettingRow>
      <SettingRow title="Transitions" note="Between shots. A join inside a spoken word is forced to a cut.">
        <Segmented
          label="Transitions"
          options={TRANSITIONS}
          value={s.transition}
          labels={TRANSITION_LABELS}
          onChange={set('export_transition')}
          disabled={readOnly}
        />
      </SettingRow>
      <div className="flex flex-col border-b border-border-subtle">
        <div className="flex items-center gap-[16px] p-[13px_15px]">
          <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
            <span className="text-ui font-medium">Captions</span>
            <span className="text-meta text-text-tertiary">
              Timed from the voiceover alignment — no extra API cost. Unavailable without a voiceover.
            </span>
          </span>
          <Segmented
            label="Captions"
            options={CAPTION_MODES}
            value={s.captions}
            labels={CAPTION_MODE_LABELS}
            onChange={set('caption_mode')}
            disabled={readOnly || !hasVoiceover}
          />
        </div>
        {captionsBurned(s.captions) && (
          <div className="mx-[15px] mb-[14px] flex flex-col gap-[11px] rounded-r-control border-l-2 border-border-strong bg-bg-surface p-[12px_14px]">
            <div className="flex items-center gap-[16px]">
              <span className="flex-1 text-small text-text-secondary">Style preset</span>
              <div className="w-[180px] flex-none">
                <CustomSelect
                  ariaLabel="Caption style preset"
                  options={EXPOSED_CAPTION_STYLES.map((v) => ({ value: v, label: CAPTION_STYLE_LABELS[v] }))}
                  value={s.captionStyle}
                  onCommit={(v) => v !== s.captionStyle && set('caption_style')(v)}
                  disabled={readOnly}
                  triggerClassName={selectTrigger}
                />
              </div>
            </div>
            <div className="flex items-center gap-[16px]">
              <span className="flex-1 text-small text-text-secondary">Position</span>
              <Segmented
                label="Caption position"
                fill
                options={CAPTION_POSITIONS}
                value={s.captionPosition}
                labels={CAPTION_POSITION_LABELS}
                onChange={set('caption_position')}
                disabled={readOnly}
              />
            </div>
          </div>
        )}
      </div>
      <SettingRow title="Loudness" note="Applied to the final mix on render." last>
        <div className="w-[220px] flex-none">
          <CustomSelect
            ariaLabel="Loudness"
            options={LOUDNESS_PRESETS.map((v) => ({ value: v, label: loudnessLabel(v) }))}
            value={s.loudness}
            onCommit={(v) => v !== s.loudness && set('loudness_preset')(v)}
            disabled={readOnly}
            triggerClassName={selectTrigger}
          />
        </div>
      </SettingRow>
    </div>
  )
}

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function formatDuration(sec: number): string {
  const total = Math.round(sec)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function formatLeft(sec: number): string {
  return sec >= 90 ? `~${Math.round(sec / 60)}m left` : `~${sec}s left`
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

const chipBase = 'flex-none rounded-badge px-[7px] py-[2px] text-chip font-medium uppercase tracking-label'
const rowBase = 'flex items-center gap-[12px] rounded-control border p-[11px_13px]'
const quietButton =
  'flex h-[28px] cursor-pointer items-center rounded-control border border-border-subtle px-[10px] text-small text-text-secondary hover:bg-bg-inset hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60'

function HistoryRow({
  row,
  latest,
  filmHash,
  busy,
  onCancel,
  onRetry,
}: {
  row: ExportHistoryRow
  latest: boolean
  filmHash: string
  busy: boolean
  onCancel: () => void
  onRetry: () => void
}) {
  const [watching, setWatching] = useState(false)
  const time = formatClockTime(row.createdAt)

  if (row.status === 'succeeded') {
    const facts = [
      time,
      row.width && row.height ? `${row.width} × ${row.height}` : null,
      row.durationSec !== null ? formatDuration(row.durationSec) : null,
      row.sizeBytes !== null ? formatSize(row.sizeBytes) : null,
    ].filter(Boolean)
    return (
      <div data-testid="export-row" data-status="succeeded" className="flex flex-col gap-[10px]">
        <div className={`${rowBase} ${latest ? 'border-border-subtle bg-bg-surface' : 'border-border-subtle bg-bg-canvas'}`}>
          <span className={`${chipBase} bg-status-done-bg text-status-done-fg`}>{latest ? 'Latest' : 'Done'}</span>
          <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
            <span className="flex items-center gap-[8px] text-small font-medium">
              <span className="truncate">{facts.join(' · ')}</span>
              {row.filmHash !== filmHash && (
                <span
                  data-testid="export-edited-since"
                  className={`${chipBase} border border-status-stale-line bg-status-stale-bg text-status-stale-fg`}
                >
                  Edited since
                </span>
              )}
            </span>
            {row.settings && <span className="text-meta text-text-tertiary">{exportRowSummary(row.settings)}</span>}
          </span>
          {row.urls && (
            <span className="flex flex-none items-center gap-[7px]">
              {row.urls.watch && (
                <button
                  type="button"
                  aria-expanded={watching}
                  onClick={() => setWatching((w) => !w)}
                  className="flex h-[28px] cursor-pointer items-center rounded-control border border-border-strong px-[10px] text-small text-text-primary hover:bg-bg-inset"
                >
                  {watching ? 'Close' : 'Watch'}
                </button>
              )}
              {row.urls.download && (
                <a href={row.urls.download} className={quietButton}>
                  Download
                </a>
              )}
              {row.urls.watch && (
                <a href={row.urls.watch} target="_blank" rel="noopener noreferrer" className={quietButton}>
                  Open
                </a>
              )}
              {row.urls.srt && (
                <a href={row.urls.srt} className={`${quietButton} font-mono text-mono`}>
                  .srt
                </a>
              )}
              {row.urls.chapters && (
                <a href={row.urls.chapters} className={quietButton}>
                  Chapters
                </a>
              )}
            </span>
          )}
        </div>
        {watching && row.urls?.watch && (
          <video
            data-testid="export-player"
            src={row.urls.watch}
            controls
            autoPlay
            className="max-h-[480px] self-center rounded-frame bg-bg-well"
          />
        )}
      </div>
    )
  }

  if (row.status === 'rendering') {
    return (
      <div data-testid="export-row" data-status="rendering" className={`${rowBase} border-sb-active-line bg-bg-canvas`}>
        <span className={`${chipBase} bg-sb-active-bg text-sb-active-fg`}>Rendering</span>
        <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
          <span className="text-small text-text-secondary">
            {time} · rendering on the export worker{row.secondsLeft !== null ? ` · ${formatLeft(row.secondsLeft)}` : ''}
          </span>
          <span className="block h-[3px] overflow-hidden rounded-[2px] bg-sb-active-line">
            <span className="block h-[3px] rounded-[2px] bg-sb-active-fg" style={{ width: `${row.progress}%` }} />
          </span>
        </span>
        <span className="flex-none font-mono text-mono text-sb-active-fg">{row.progress}%</span>
      </div>
    )
  }

  if (row.status === 'queued') {
    return (
      <div data-testid="export-row" data-status="queued" className={`${rowBase} border-border-subtle bg-bg-canvas`}>
        <span className={`${chipBase} bg-status-draft-bg text-status-draft-fg`}>Queued</span>
        <span className="flex-1 text-small text-text-secondary">
          {time} · waiting for a worker{row.queuePosition ? ` · position ${row.queuePosition}` : ''}
        </span>
        <button type="button" disabled={busy} onClick={onCancel} className={quietButton}>
          Cancel
        </button>
      </div>
    )
  }

  if (row.status === 'failed') {
    return (
      <div data-testid="export-row" data-status="failed" className={`${rowBase} border-status-failed-line bg-bg-canvas`}>
        <span className={`${chipBase} bg-status-failed-bg text-status-failed-fg`}>Failed</span>
        <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span className="text-small text-text-secondary">
            {time} · {lowerFirst(row.error ?? 'The render failed. Your settings and the mix are saved.')}
          </span>
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={onRetry}
          className="flex h-[28px] flex-none cursor-pointer items-center rounded-control border border-status-failed-line px-[11px] text-small font-medium text-status-failed-fg hover:bg-status-failed-bg disabled:cursor-not-allowed disabled:opacity-60"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div data-testid="export-row" data-status="cancelled" className={`${rowBase} border-border-subtle bg-bg-canvas`}>
      <span className={`${chipBase} bg-status-draft-bg text-status-draft-fg`}>Cancelled</span>
      <span className="flex-1 text-small text-text-tertiary">{time} · cancelled before it started</span>
    </div>
  )
}

export function ExportSection({ initialExports }: { initialExports: ExportsData }) {
  const { projectId, resolvedExport, exportSettingError, filmHash } = useStoryboard()
  const { data, active, refresh } = useExportsPoll(projectId, initialExports)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const act = async (url: string) => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const res = await fetch(url, { method: 'POST' })
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) setError(body?.error ?? 'Something went wrong. Try again.')
      await refresh()
    } catch {
      setError('Something went wrong. Try again.')
    } finally {
      setPending(false)
    }
  }

  const latestSucceeded = data.rows.find((r) => r.status === 'succeeded')?.id ?? null

  return (
    <div data-testid="export-section" className="flex flex-none flex-col gap-[12px]">
      <div className="flex items-baseline gap-[12px]">
        <span className="text-screen font-medium tracking-snug">Export</span>
        <span className="flex-1 text-meta text-text-tertiary">Renders your stills with the mix. No video credits are spent.</span>
      </div>

      {/* Collapsed: the bordered summary row (canvas 15a). Open: a plain heading over the panel (15g). */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex cursor-pointer items-center gap-[12px] text-left ${
          open ? 'py-[2px]' : 'rounded-frame border border-border-subtle bg-bg-canvas p-[13px_15px] hover:border-border-strong'
        }`}
      >
        <Chevron open={open} />
        <span className={open ? 'flex-1 text-section font-medium tracking-micro' : 'flex-none text-ui font-medium'}>
          Export settings
        </span>
        <span data-testid="export-summary" className={`text-meta text-text-tertiary ${open ? '' : 'flex-1'}`}>
          {exportSummary(resolvedExport)}
        </span>
      </button>
      {open && <ExportSettingsPanel />}
      {exportSettingError && (
        <span role="alert" className="text-small text-status-failed-fg">
          {exportSettingError}
        </span>
      )}

      <div className="flex items-center gap-[14px]">
        <span className="flex-1 text-meta leading-[1.5] text-text-tertiary">
          Renders your stills with the mix. No video credits are spent — this is not a video model.
        </span>
        <button
          type="button"
          data-testid="export-slideshow"
          disabled={pending || active}
          onClick={() => void act(`/api/projects/${projectId}/exports`)}
          className="flex h-[36px] flex-none cursor-pointer items-center gap-[9px] whitespace-nowrap rounded-control border border-border-strong bg-bg-inset px-rc-md text-control font-medium text-text-primary hover:border-border-strong-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? 'Queuing…' : 'Export slideshow'}
          <span className="font-mono text-mono font-normal text-text-tertiary">free</span>
        </button>
      </div>
      {error && (
        <span role="alert" data-testid="export-error" className="text-small text-status-failed-fg">
          {error}
        </span>
      )}

      {data.rows.length > 0 && (
        <div data-testid="export-history" className="flex flex-col gap-[8px]">
          <span className="text-label uppercase tracking-label text-text-tertiary">Export history</span>
          {data.rows.map((row) => (
            <HistoryRow
              key={row.id}
              row={row}
              latest={row.id === latestSucceeded}
              filmHash={filmHash}
              busy={pending}
              onCancel={() => void act(`/api/projects/${projectId}/exports/${row.id}/cancel`)}
              onRetry={() => void act(`/api/projects/${projectId}/exports/${row.id}/retry`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

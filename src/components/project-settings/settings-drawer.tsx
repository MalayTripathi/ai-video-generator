'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { DEFAULT_DURATION_TARGET, type DurationTarget } from '@/lib/config/duration'
import type { AspectRatio } from '@/lib/config/enums'
import { isRegisteredVideoModel } from '@/lib/config/models'
import { QualityPicker } from '@/components/quality/quality-picker'
import { maxShotSeconds, parseQualitySettings, type QualitySettings } from '@/lib/quality/estimate'
import { isVideoSettingsLocked, type ShotTrim } from '@/lib/projects/settings'
import { previewProjectSettingsTrims, saveProjectSettings } from '@/app/(app)/projects/[id]/actions'

export type SettingsProject = {
  id: string
  quality_preset: string
  video_model: string | null
  video_resolution: string
  image_quality: string
  image_model: string
  aspect_ratio: string | null
  duration_target: string | null
  furthest_step: number
}

// The project's saved settings as picker state. A stored preset whose values no longer
// match it reads as 'custom'; anything the registry can't read leaves the chip inert.
function savedSettings(project: SettingsProject): QualitySettings | null {
  const raw = {
    preset: project.quality_preset,
    videoModel: project.video_model,
    videoResolution: project.video_resolution,
    imageQuality: project.image_quality,
    imageModel: project.image_model,
  }
  try {
    return parseQualitySettings(raw)
  } catch {
    try {
      return parseQualitySettings({ ...raw, preset: 'custom' })
    } catch {
      return null
    }
  }
}

const sameSettings = (a: QualitySettings, b: QualitySettings) =>
  a.preset === b.preset &&
  a.videoModel === b.videoModel &&
  a.videoResolution === b.videoResolution &&
  a.imageQuality === b.imageQuality &&
  a.imageModel === b.imageModel

type Confirm = { trims: ShotTrim[]; modelChanged: boolean }

// The header settings chip and the drawer it opens (canvas section 18). Changes are
// staged: nothing is written until Apply, which confirms first when the change has
// consequences - over-length shots to trim, or video prompts to mark stale.
export function SettingsChip({ project, label }: { project: SettingsProject; label: string }) {
  const router = useRouter()
  const saved = savedSettings(project)
  const [open, setOpen] = useState(false)
  const [staged, setStaged] = useState<QualitySettings | null>(saved)
  // Remounts the picker on every open, so Advanced and the notice start from the saved value.
  const [openCount, setOpenCount] = useState(0)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const chipClass =
    'flex items-center gap-[5px] rounded-full border border-accent-faint px-[10px] py-1 text-chip text-accent'

  if (!saved || !staged) return <span className={chipClass}>{label}</span>

  const locked = isVideoSettingsLocked(project.furthest_step)
  const dirty = !sameSettings(saved, staged)
  const durationTarget = (project.duration_target ?? DEFAULT_DURATION_TARGET) as DurationTarget
  const aspectRatio = (project.aspect_ratio ?? '9:16') as AspectRatio

  function openDrawer() {
    setStaged(saved)
    setOpenCount((n) => n + 1)
    setConfirm(null)
    setError(null)
    setOpen(true)
  }

  function close() {
    setOpen(false)
    setConfirm(null)
    setStaged(saved)
    setError(null)
  }

  async function commit(settings: QualitySettings, trimCount: number) {
    setBusy(true)
    setError(null)
    const result = await saveProjectSettings(project.id, settings, trimCount)
    setBusy(false)
    if (result.ok) {
      setOpen(false)
      setConfirm(null)
      router.refresh()
      return
    }
    if (result.error === 'trims_changed') {
      setConfirm({ trims: result.trims, modelChanged: true })
      return
    }
    setConfirm(null)
    setError(result.message)
  }

  async function apply() {
    if (!staged || !saved || !dirty || busy) return
    const modelChanged = staged.videoModel !== saved.videoModel
    if (!modelChanged) {
      // A resolution, image or preset change with the same video model applies directly.
      await commit(staged, 0)
      return
    }
    let trims: ShotTrim[] = []
    const savedModel = project.video_model
    const lowers = !isRegisteredVideoModel(savedModel) || maxShotSeconds(staged.videoModel) < maxShotSeconds(savedModel)
    if (lowers) {
      setBusy(true)
      const preview = await previewProjectSettingsTrims(project.id, staged.videoModel)
      setBusy(false)
      if (preview.error || preview.trims === null) {
        setError(preview.error ?? 'Could not check shot lengths. Try again.')
        return
      }
      trims = preview.trims
    }
    setConfirm({ trims, modelChanged })
  }

  return (
    <>
      <button
        type="button"
        onClick={openDrawer}
        aria-haspopup="dialog"
        data-testid="project-settings-chip"
        className={`${chipClass} cursor-pointer outline-none hover:bg-accent-wash focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
      >
        {label}
      </button>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-40">
            <div className="absolute inset-0 bg-black/40" onClick={close} aria-hidden="true" />
            <aside
              role="dialog"
              aria-modal="true"
              aria-label="Project settings"
              data-testid="project-settings-drawer"
              className="absolute top-0 right-0 bottom-0 flex w-[440px] max-w-full flex-col border-l border-border-strong bg-bg-canvas text-text-primary shadow-card-hover"
            >
              <div className="flex h-[60px] flex-none items-center justify-between border-b border-border-subtle pr-rc-md pl-rc-lg">
                <span className="text-section font-medium tracking-micro">Project settings</span>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close"
                  className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-control text-text-secondary outline-none hover:bg-bg-inset hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M1.5 1.5 10.5 10.5M10.5 1.5 1.5 10.5" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                </button>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-rc-lg pt-[20px] pb-[28px]">
                <div className="flex flex-col gap-rc-xs">
                  {locked && (
                    <div
                      role="status"
                      data-testid="project-settings-locked"
                      className="flex items-start gap-rc-xs rounded-badge border border-border-subtle bg-bg-inset px-[10px] py-rc-xs text-meta leading-[1.45] text-text-secondary"
                    >
                      <svg width="10" height="12" viewBox="0 0 10 12" fill="none" aria-hidden="true" className="mt-[2px] flex-none">
                        <rect x="0.75" y="4.9" width="8.5" height="6.35" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
                        <path d="M2.75 4.9V3.25a2.25 2.25 0 0 1 4.5 0V4.9" stroke="currentColor" strokeWidth="1.2" />
                      </svg>
                      Video settings are locked after generation starts. You can still change the model for individual
                      shots on Video Prompts.
                    </div>
                  )}
                  <span className="text-meta leading-[1.5] text-text-tertiary">
                    Changes apply to new work only. Nothing already generated is regenerated.
                  </span>
                </div>
                <QualityPicker
                  key={openCount}
                  value={staged}
                  onChange={setStaged}
                  durationTarget={durationTarget}
                  aspectRatio={aspectRatio}
                  locked={locked}
                />
                {error && (
                  <span role="alert" className="text-meta text-status-failed-fg">
                    {error}
                  </span>
                )}
              </div>

              <div className="flex flex-none justify-end gap-[10px] border-t border-border-subtle px-rc-lg py-[14px]">
                <button
                  type="button"
                  onClick={close}
                  className="h-9 cursor-pointer rounded-control border border-border-strong bg-transparent px-rc-md text-control text-text-primary outline-none hover:bg-bg-inset focus-visible:outline-2 focus-visible:outline-accent"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={apply}
                  disabled={!dirty || busy}
                  aria-busy={busy}
                  data-testid="project-settings-apply"
                  className="h-9 cursor-pointer rounded-control border border-accent bg-transparent px-rc-md text-control font-medium text-accent outline-none hover:bg-accent-wash focus-visible:outline-2 focus-visible:outline-accent active:border-accent-active active:bg-accent-wash-strong active:text-accent-active disabled:cursor-not-allowed disabled:border-border-subtle disabled:bg-bg-inset disabled:text-text-tertiary"
                >
                  Apply changes
                </button>
              </div>
            </aside>
            {confirm && (
              <ApplyConfirm
                confirm={confirm}
                maxSeconds={maxShotSeconds(staged.videoModel)}
                busy={busy}
                onCancel={() => setConfirm(null)}
                onConfirm={() => commit(staged, confirm.trims.length)}
              />
            )}
          </div>,
          document.body
        )}
    </>
  )
}

function ApplyConfirm({
  confirm,
  maxSeconds,
  busy,
  onCancel,
  onConfirm,
}: {
  confirm: Confirm
  maxSeconds: number
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    confirmRef.current?.focus()
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  const count = confirm.trims.length
  const title =
    count > 0 ? `${count} ${count === 1 ? 'shot is' : 'shots are'} longer than ${maxSeconds}s` : 'Change the video model?'
  const confirmLabel = count > 0 ? `Trim ${count} ${count === 1 ? 'shot' : 'shots'} and apply` : 'Apply changes'

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 p-rc-md" onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="settings-confirm-title"
        data-testid="project-settings-confirm"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-[460px] flex-col gap-[14px] rounded-frame border border-border-strong bg-bg-canvas px-[26px] py-rc-lg text-text-primary shadow-card-hover"
      >
        <span id="settings-confirm-title" className="text-section font-medium tracking-micro">
          {title}
        </span>
        {count > 0 && (
          <ul className="flex max-h-[320px] flex-col overflow-y-auto rounded-control border border-border-subtle">
            {confirm.trims.map((trim, i) => (
              <li
                key={trim.shotId}
                data-testid="project-settings-trim"
                className={`flex flex-col gap-[3px] px-[12px] py-[9px] ${i > 0 ? 'border-t border-border-subtle' : ''}`}
              >
                <span className="text-small tabular-nums text-text-primary">
                  Shot {trim.number} · {trim.fromSeconds}s → {trim.toSeconds}s
                </span>
                {trim.hasDialogue && (
                  <span className="flex items-center gap-[6px] text-meta text-status-active-fg">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="flex-none">
                      <path d="M6 1.25 11 10.5H1L6 1.25Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                      <rect x="5.4" y="4.5" width="1.2" height="3.2" fill="currentColor" />
                      <rect x="5.4" y="8.4" width="1.2" height="1.2" fill="currentColor" />
                    </svg>
                    Has dialogue — speech may be cut.
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {confirm.modelChanged && (
          <span className="text-small leading-[1.55] text-text-secondary">
            Video prompts will be marked stale. You can regenerate them on the Video Prompts step.
          </span>
        )}
        <div className="flex justify-end gap-[10px] pt-[2px]">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 cursor-pointer rounded-control border border-border-strong bg-transparent px-rc-md text-control text-text-primary outline-none hover:bg-bg-inset focus-visible:outline-2 focus-visible:outline-accent"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy}
            data-testid="project-settings-confirm-apply"
            className="h-9 cursor-pointer rounded-control border border-accent bg-transparent px-rc-md text-control font-medium text-accent outline-none hover:bg-accent-wash focus-visible:outline-2 focus-visible:outline-accent active:border-accent-active active:bg-accent-wash-strong active:text-accent-active disabled:cursor-not-allowed disabled:opacity-60"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}


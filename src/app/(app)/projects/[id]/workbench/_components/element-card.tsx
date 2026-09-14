'use client'

import { useRef, useState, type ChangeEvent } from 'react'
import type { ProjectElement } from '@/lib/elements/read'
import type { ElementType } from '@/lib/config/enums'
import { ELEMENT_TYPE_DOT_CLASSNAME } from '@/lib/element-type-labels'
import { Spinner } from '@/components/spinner'
import { updateElementName, updateElementDescription } from '../actions'
import { useAssets } from './assets-context'
import { ElementImage } from './element-image'
import { ChangeMenu } from './change-menu'
import { DeleteElementModal } from './delete-element-modal'

type ImageOp = 'idle' | 'uploading' | 'generating' | 'failed'

function initialImageOp(element: ProjectElement): ImageOp {
  if (element.reference_image_path) return 'idle'
  if (element.status === 'generating') return 'generating'
  return 'idle'
}

function DeleteIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M1.4 1.4 8.6 8.6M8.6 1.4 1.4 8.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function WarningIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="flex-none">
      <circle cx="7" cy="7" r="5.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7 4.2v3.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="7" cy="9.8" r="0.75" fill="currentColor" />
    </svg>
  )
}

export function ElementCard({ element, groupType }: { element: ProjectElement; groupType: ElementType }) {
  const { projectId, updateElementLocal, generateCredits, hasInsufficientBalance } = useAssets()
  const [mode, setMode] = useState<'view' | 'editing'>('view')
  const [nameDraft, setNameDraft] = useState(element.name)
  const [descriptionDraft, setDescriptionDraft] = useState(element.description ?? '')
  const [savePending, setSavePending] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [imageOp, setImageOp] = useState<ImageOp>(() => initialImageOp(element))
  const [failedSource, setFailedSource] = useState<'upload' | 'generate' | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [changeMenuOpen, setChangeMenuOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const canDelete = groupType !== 'style'
  const inFlight = imageOp === 'uploading' || imageOp === 'generating'
  const hasReference = imageOp === 'idle' && !!element.reference_image_path

  function openEdit() {
    setNameDraft(element.name)
    setDescriptionDraft(element.description ?? '')
    setSaveError(null)
    setMode('editing')
  }

  function cancelEdit() {
    setMode('view')
    setSaveError(null)
  }

  async function handleSave() {
    setSavePending(true)
    setSaveError(null)

    if (nameDraft.trim() !== element.name) {
      const result = await updateElementName(element.id, nameDraft)
      if (!result.success) {
        setSavePending(false)
        setSaveError(result.error)
        return
      }
      if (!result.unchanged) updateElementLocal(element.id, { name: nameDraft.trim() })
    }

    const trimmedDescription = descriptionDraft.trim() || null
    if (trimmedDescription !== element.description) {
      const result = await updateElementDescription(element.id, trimmedDescription)
      if (!result.success) {
        setSavePending(false)
        setSaveError(result.error)
        return
      }
      if (!result.unchanged) updateElementLocal(element.id, { description: trimmedDescription })
    }

    setSavePending(false)
    setMode('view')
  }

  async function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setImageOp('uploading')
    setImageError(null)

    const formData = new FormData()
    formData.append('file', file)

    try {
      const response = await fetch(`/api/projects/${projectId}/elements/${element.id}/reference`, {
        method: 'POST',
        body: formData,
      })
      const data = await response.json()
      if (!data.success) {
        setFailedSource('upload')
        setImageError(data.error ?? 'Upload failed')
        setImageOp('failed')
        return
      }
      updateElementLocal(element.id, { reference_image_path: data.path, reference_image_url: data.url })
      setImageOp('idle')
    } catch {
      setFailedSource('upload')
      setImageError('Upload failed')
      setImageOp('failed')
    }
  }

  async function handleGenerate() {
    setImageOp('generating')
    setImageError(null)

    try {
      const response = await fetch(`/api/projects/${projectId}/elements/${element.id}/reference/generate`, {
        method: 'POST',
      })
      const data = await response.json()
      if (!data.ok) {
        setFailedSource('generate')
        setImageError(data.error ?? "Couldn't generate")
        setImageOp('failed')
        return
      }
      updateElementLocal(element.id, {
        reference_image_path: data.data.path,
        reference_image_url: data.data.url,
        status: 'ready',
      })
      setImageOp('idle')
    } catch {
      setFailedSource('generate')
      setImageError("Couldn't generate")
      setImageOp('failed')
    }
  }

  async function handleRemove() {
    const previousPath = element.reference_image_path
    const previousUrl = element.reference_image_url
    updateElementLocal(element.id, { reference_image_path: null, reference_image_url: null })

    try {
      const response = await fetch(`/api/projects/${projectId}/elements/${element.id}/reference`, {
        method: 'DELETE',
      })
      const data = await response.json()
      if (!data.success) {
        // Revert: the image is still really there.
        updateElementLocal(element.id, { reference_image_path: previousPath, reference_image_url: previousUrl })
      }
    } catch {
      updateElementLocal(element.id, { reference_image_path: previousPath, reference_image_url: previousUrl })
    }
  }

  function openFilePicker() {
    fileInputRef.current?.click()
  }

  return (
    <div
      data-testid="element-card"
      data-element-name={element.name}
      className={`relative flex flex-col overflow-hidden rounded-control border bg-bg-surface shadow-card ${
        mode === 'editing' ? 'border-accent shadow-[0_0_0_3px_rgba(91,91,214,0.18)]' : 'border-border-subtle'
      }`}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        data-testid="element-reference-file-input"
        onChange={handleFileSelected}
      />

      <div className="relative border-b border-border-subtle" style={{ aspectRatio: '1.1' }}>
        {imageOp === 'uploading' && (
          <div className="flex h-full w-full flex-col items-stretch justify-center gap-[7px] bg-bg-well px-[14px]">
            <span className="text-meta text-text-secondary">Uploading…</span>
            <span className="block h-1 overflow-hidden rounded-full bg-bg-inset">
              <span className="block h-1 w-2/3 animate-pulse rounded-full bg-accent" />
            </span>
          </div>
        )}

        {imageOp === 'generating' && (
          <div
            className="flex h-full w-full flex-col items-stretch justify-center gap-[7px] px-[14px]"
            style={{
              backgroundImage:
                'linear-gradient(90deg, var(--skeleton-base) 0%, var(--skeleton-hi) 50%, var(--skeleton-base) 100%)',
              backgroundSize: '520px 100%',
              animation: 'rc-shimmer 1.4s linear infinite',
            }}
          >
            <span className="flex items-center gap-[6px] text-meta text-text-secondary">
              <Spinner className="h-[11px] w-[11px]" thickness={1.3} />
              Generating
            </span>
            <span className="font-mono text-mono leading-[1.45] text-text-tertiary">
              About 20 seconds. You can keep working — it appears here when it&rsquo;s done.
            </span>
          </div>
        )}

        {imageOp === 'failed' && (
          <div className="flex h-full w-full flex-col items-stretch justify-center gap-[7px] bg-bg-well px-[12px]">
            <span className="flex items-center gap-[6px] text-meta font-medium text-status-failed-fg">
              <WarningIcon />
              {failedSource === 'upload' ? "Couldn't upload" : "Couldn't generate"}
            </span>
            <span className="font-mono text-mono leading-[1.45] text-text-secondary">
              {imageError}
              {failedSource === 'generate' ? ' No credit was spent.' : ''}
            </span>
            <span className="mt-[2px] flex gap-[6px]">
              <button
                type="button"
                onClick={failedSource === 'upload' ? openFilePicker : handleGenerate}
                className="flex h-[26px] cursor-pointer items-center rounded-control border border-border-strong bg-bg-surface px-[9px] text-meta text-text-primary hover:border-border-strong-hover hover:bg-bg-inset"
              >
                Try again
              </button>
              {failedSource === 'generate' && (
                <button
                  type="button"
                  onClick={openFilePicker}
                  className="flex h-[26px] cursor-pointer items-center text-meta text-accent hover:underline"
                >
                  Upload instead
                </button>
              )}
            </span>
          </div>
        )}

        {imageOp === 'idle' && hasReference && element.reference_image_path && (
          <>
            <ElementImage path={element.reference_image_path} url={element.reference_image_url} alt={element.name} />
            <span className="absolute bottom-[7px] left-[7px] rounded-[3px] bg-[rgba(251,251,254,0.9)] px-[5px] py-[2px] text-[10.5px] uppercase tracking-[0.06em] text-text-secondary">
              Reference set
            </span>
            <span className="absolute bottom-[7px] right-[7px]">
              <button
                type="button"
                onClick={() => setChangeMenuOpen((v) => !v)}
                className="cursor-pointer rounded-[3px] bg-[rgba(251,251,254,0.9)] px-[6px] py-[2px] text-chip text-text-secondary hover:text-text-primary"
              >
                Change
              </button>
              {changeMenuOpen && (
                <ChangeMenu
                  onUpload={openFilePicker}
                  onGenerate={handleGenerate}
                  onRemove={handleRemove}
                  generateCredits={generateCredits}
                  generateDisabled={hasInsufficientBalance}
                  onClose={() => setChangeMenuOpen(false)}
                />
              )}
            </span>
          </>
        )}

        {imageOp === 'idle' && !hasReference && (
          <div className="flex h-full w-full flex-col items-center justify-center gap-[6px] bg-bg-well p-[10px]">
            <button
              type="button"
              onClick={openFilePicker}
              className="flex h-[27px] cursor-pointer items-center rounded-control border border-border-strong bg-bg-surface px-[10px] text-meta text-text-primary hover:border-border-strong-hover hover:bg-bg-inset"
            >
              Upload
            </button>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={hasInsufficientBalance}
              className="flex h-[27px] cursor-pointer items-center rounded-control border border-accent px-[10px] text-meta font-medium text-accent hover:bg-accent-wash disabled:cursor-not-allowed disabled:border-border-strong disabled:text-text-quiet disabled:hover:bg-transparent"
            >
              Generate · {generateCredits} credit{generateCredits === 1 ? '' : 's'}
            </button>
            <span className="text-center font-mono text-mono text-text-tertiary">
              or leave it — description is used
            </span>
          </div>
        )}

        {!inFlight && canDelete && mode === 'view' && (
          <button
            type="button"
            title="Delete element"
            data-testid="delete-element-trigger"
            onClick={() => setDeleteOpen(true)}
            className="absolute right-[6px] top-[6px] flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-badge bg-[rgba(251,251,254,0.9)] text-text-tertiary hover:bg-status-failed-bg hover:text-status-failed-fg"
          >
            <DeleteIcon />
          </button>
        )}
      </div>

      <div className="flex flex-col gap-[4px] p-[9px_10px_11px]">
        {mode === 'view' ? (
          <>
            <span className="flex items-center gap-[6px] text-control font-medium tracking-[-0.01em]">
              <span className={`h-[5px] w-[5px] flex-none rounded-full ${ELEMENT_TYPE_DOT_CLASSNAME[groupType]}`} />
              <button type="button" onClick={openEdit} className="cursor-pointer truncate text-left hover:underline">
                {element.name}
              </button>
            </span>
            <button
              type="button"
              onClick={openEdit}
              className="cursor-pointer text-left text-meta leading-[1.45] text-text-secondary hover:text-text-primary"
              style={{
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {element.description || 'No description yet.'}
            </button>
          </>
        ) : (
          <div className="flex flex-col gap-[8px]">
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="Name"
              className="h-8 rounded-control border border-accent bg-bg-canvas px-[9px] text-control outline-none"
            />
            <textarea
              value={descriptionDraft}
              onChange={(e) => setDescriptionDraft(e.target.value)}
              placeholder="Description — what should it look like?"
              rows={3}
              className="min-h-[76px] resize-none rounded-control border border-border-strong bg-bg-canvas p-[8px_9px] text-meta leading-[1.45] outline-none focus:border-accent"
            />
            {saveError && <span className="text-meta text-status-failed-fg">{saveError}</span>}
            <div className="flex gap-[6px]">
              <button
                type="button"
                onClick={handleSave}
                disabled={savePending || !nameDraft.trim()}
                className="flex h-[30px] flex-1 cursor-pointer items-center justify-center rounded-control border border-accent text-meta font-medium text-accent hover:bg-accent-wash disabled:cursor-not-allowed disabled:opacity-60"
              >
                {savePending ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                disabled={savePending}
                className="flex h-[30px] flex-1 cursor-pointer items-center justify-center rounded-control border border-border-strong text-meta text-text-primary hover:bg-bg-inset disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {canDelete && (
        <DeleteElementModal
          open={deleteOpen}
          elementId={element.id}
          elementName={element.name}
          onClose={() => setDeleteOpen(false)}
        />
      )}
    </div>
  )
}

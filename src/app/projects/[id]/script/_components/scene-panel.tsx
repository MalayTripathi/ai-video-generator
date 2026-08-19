import type { Scene } from '../../types'

function ContinueIcon() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden="true">
      <path d="M0.75 4.5h8.5M6.25 1.25 9.5 4.5 6.25 7.75" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function Spinner() {
  return (
    <span
      className="block h-[13px] w-[13px] animate-spin rounded-full border-[1.5px] border-accent-faint border-t-accent"
      aria-hidden
    />
  )
}

function SkeletonRow({ width }: { width: string }) {
  return (
    <div className="flex gap-[18px] border-b border-border-hairline px-rc-lg py-rc-md last:border-b-0">
      <span className="w-16 flex-none text-label uppercase tracking-label text-text-quiet">···</span>
      <div className="flex flex-1 flex-col gap-rc-xs">
        <span
          className="block h-[10px] rounded-[3px] bg-[linear-gradient(90deg,var(--skeleton-base)_0%,var(--skeleton-hi)_50%,var(--skeleton-base)_100%)] bg-[length:400px_100%]"
          style={{ width, animation: 'rc-shimmer 1.2s linear infinite' }}
        />
      </div>
    </div>
  )
}

function EmptyScenePanel() {
  return (
    <div className="flex flex-1 items-center justify-center px-rc-xl">
      <div className="flex max-w-sm flex-col items-center gap-rc-sm rounded-frame border border-dashed border-border-muted bg-bg-well px-rc-xl py-rc-2xl text-center">
        <h2 className="text-section font-medium tracking-snug text-text-primary">No script yet</h2>
        <p className="text-ui text-text-secondary">
          Describe your video in the chat to get a first draft.
        </p>
      </div>
    </div>
  )
}

export function ScenePanel({
  scenes,
  pending,
  justChangedKeys,
  onContinue,
  promptsPending,
  promptsError,
}: {
  scenes: Scene[]
  pending: boolean
  justChangedKeys: Set<string>
  onContinue: () => void
  promptsPending: boolean
  promptsError: string | null
}) {
  const hasScenes = scenes.length > 0
  const wordCount = scenes.reduce(
    (sum, scene) => sum + scene.voice_over.trim().split(/\s+/).filter(Boolean).length,
    0
  )

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-none items-baseline justify-between px-rc-lg pt-[20px] lg:px-rc-xl xl:px-rc-2xl">
        <span className="text-section font-medium tracking-micro text-text-primary">Script</span>
        {hasScenes && (
          <span className="font-mono text-label text-text-tertiary">{wordCount} words</span>
        )}
      </div>

      {!hasScenes && !pending && <EmptyScenePanel />}

      {!hasScenes && pending && (
        <div className="flex-1 overflow-hidden px-rc-lg pt-[18px] lg:px-rc-xl xl:px-rc-2xl">
          <div className="overflow-hidden rounded-control border border-border-subtle bg-bg-surface">
            <SkeletonRow width="100%" />
            <SkeletonRow width="64%" />
            <SkeletonRow width="88%" />
          </div>
        </div>
      )}

      {hasScenes && (
        <div className="flex-1 overflow-y-auto px-rc-lg pt-[18px] lg:px-rc-xl xl:px-rc-2xl">
          <div className="overflow-hidden rounded-control border border-border-subtle bg-bg-surface">
            {scenes.map((scene) => {
              const changed = justChangedKeys.has(scene.scene_key)
              return (
                <div
                  key={scene.id ?? scene.scene_key}
                  className={`relative flex items-baseline gap-[18px] border-b border-border-hairline px-rc-lg py-rc-md last:border-b-0 ${
                    changed ? 'bg-accent-wash' : ''
                  }`}
                >
                  {changed && (
                    <span className="absolute bottom-[18px] left-0 top-[18px] w-[2px] rounded-[1px] bg-accent" />
                  )}
                  <span
                    className={`w-16 flex-none text-label uppercase tracking-label ${changed ? 'text-accent' : 'text-text-tertiary'}`}
                  >
                    Scene {scene.position}
                  </span>
                  <p className="m-0 text-control leading-[1.6] text-text-primary">{scene.voice_over}</p>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex flex-none items-center justify-between px-rc-lg pt-rc-lg pb-rc-2xl lg:px-rc-xl xl:px-rc-2xl">
        <div className="flex items-center gap-rc-md">
          <span className="text-small text-text-tertiary">
            {hasScenes ? `${scenes.length} scene${scenes.length === 1 ? '' : 's'}` : ''}
          </span>
          {promptsError && <p className="m-0 text-small text-status-failed-fg">{promptsError}</p>}
        </div>
        {hasScenes ? (
          <button
            type="button"
            onClick={onContinue}
            disabled={promptsPending}
            className="flex h-10 items-center gap-rc-xs rounded-control border border-accent px-rc-md text-control font-medium text-accent outline-none hover:bg-accent-wash focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:border-accent-active active:bg-accent-wash-strong active:text-accent-active disabled:opacity-45"
          >
            {promptsPending ? 'Preparing prompts…' : 'Continue to voiceover'}
            {promptsPending ? <Spinner /> : <ContinueIcon />}
          </button>
        ) : (
          <span
            aria-disabled
            className="flex h-10 items-center gap-rc-xs rounded-control border border-accent px-rc-md text-control font-medium text-accent opacity-45"
          >
            Continue to voiceover
            <ContinueIcon />
          </span>
        )}
      </div>
    </div>
  )
}

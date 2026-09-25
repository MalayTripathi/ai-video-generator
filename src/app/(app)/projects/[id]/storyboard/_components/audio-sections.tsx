import { creditsFor } from '@/lib/config/credits'
import { formatCredits } from '@/lib/format-credits'

// The Music lane control under the timeline, in its empty state (canvas 15a/15f). Nothing
// here is wired yet: every control is drawn exactly as designed and does nothing. The
// Voiceover card is live - see voiceover-card.tsx.

// static until music - the style prompt field
function StylePromptField() {
  return (
    <span className="flex h-[32px] min-w-0 flex-1 cursor-text items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-control border border-border-strong bg-bg-surface px-[11px] text-small text-text-quiet hover:border-border-strong-hover">
      A style prompt derived from your script
    </span>
  )
}

// static until music - upload a music bed
function UploadMusicButton() {
  return (
    <span className="flex h-[30px] flex-none cursor-pointer items-center rounded-control border border-border-subtle px-[11px] text-small text-text-secondary hover:bg-bg-inset hover:text-text-primary">
      Upload
    </span>
  )
}

// static until music - generate the music bed
function GenerateMusicButton() {
  const credits = creditsFor({ step: 'storyboard', operation: 'background_music', quantity: 1 })
  return (
    <span className="flex h-[30px] flex-none cursor-pointer items-center gap-[8px] whitespace-nowrap rounded-control border border-border-strong bg-bg-inset px-[13px] text-small leading-none font-medium text-text-primary hover:border-border-strong-hover">
      Generate music
      <span className="font-mono text-mono font-normal text-text-tertiary">{formatCredits(credits)} cr</span>
    </span>
  )
}

export function MusicSection() {
  return (
    <div
      data-testid="music-section"
      className="flex flex-col gap-[10px] rounded-frame border border-border-subtle bg-bg-canvas p-[11px_14px]"
    >
      <div className="flex items-center gap-[10px]">
        <span className="flex flex-none items-center gap-[8px]">
          <span className="h-[13px] w-[2px] rounded-[1px] bg-border-strong" />
          <span className="text-label uppercase tracking-label text-text-tertiary">Music</span>
        </span>
        <span className="flex-1 text-meta text-text-tertiary">
          Optional · a style prompt derived from your script, yours to edit
        </span>
      </div>
      <div className="flex items-center gap-[10px]">
        <StylePromptField />
        <UploadMusicButton />
        <GenerateMusicButton />
      </div>
    </div>
  )
}

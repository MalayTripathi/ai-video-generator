import { creditsFor } from '@/lib/config/credits'
import { formatCredits } from '@/lib/format-credits'
import { languageLabel } from '@/lib/language-labels'

// The two audio lane controls under the timeline, in their empty states (canvas 15a/15f).
// Nothing here is wired yet: every control is drawn exactly as designed and does nothing.

const VOICES = [
  { name: 'Aria', meta: 'warm · narration', picked: true },
  { name: 'Juno', meta: 'bright · younger', picked: false },
  { name: 'Rafe', meta: 'low · documentary', picked: false },
  { name: 'Isla', meta: 'even · neutral', picked: false },
]

function PlayGlyph() {
  return (
    <svg width="8" height="9" viewBox="0 0 8 9" fill="none" aria-hidden="true">
      <path d="M1 1 7 4.5 1 8z" fill="currentColor" />
    </svg>
  )
}

function Chevron() {
  return (
    <svg width="8" height="5" viewBox="0 0 9 6" fill="none" aria-hidden="true">
      <path d="M1 1.25 4.5 4.75 8 1.25" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

// static until voiceover - the narration language picker
function LanguagePicker({ language }: { language: string | null }) {
  return (
    <span className="flex h-[26px] flex-none cursor-pointer items-center gap-[6px] rounded-control border border-border-subtle px-[9px] text-small text-text-secondary hover:bg-bg-inset">
      {languageLabel(language) ?? 'English'}
      <Chevron />
    </span>
  )
}

// static until voiceover - voice audition cards
function VoiceCards() {
  return (
    <div className="flex gap-[8px]">
      {VOICES.map((voice) => (
        <div
          key={voice.name}
          className={`flex h-[40px] min-w-0 flex-1 cursor-pointer items-center gap-[9px] rounded-control border px-[10px] hover:border-border-strong-hover ${
            voice.picked ? 'border-border-strong-hover bg-bg-inset' : 'border-border-subtle bg-bg-surface'
          }`}
        >
          <span className="flex h-[24px] w-[24px] flex-none items-center justify-center rounded-full border border-border-strong text-text-secondary hover:border-accent hover:text-accent">
            <PlayGlyph />
          </span>
          <span className="flex min-w-0 flex-col gap-px">
            <span className="overflow-hidden text-ellipsis whitespace-nowrap text-small font-medium">{voice.name}</span>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap text-meta text-text-tertiary">{voice.meta}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

// static until voiceover - upload an existing read
function UploadButton() {
  return (
    <span className="flex h-[30px] flex-none cursor-pointer items-center rounded-control border border-border-subtle px-[11px] text-small text-text-secondary hover:bg-bg-inset hover:text-text-primary">
      Upload
    </span>
  )
}

// static until voiceover - generate the narration
function GenerateVoiceoverButton() {
  const credits = creditsFor({ step: 'storyboard', operation: 'voiceover', quantity: 1 })
  return (
    <span className="flex h-[30px] flex-none cursor-pointer items-center gap-[8px] whitespace-nowrap rounded-control border border-border-strong bg-bg-inset px-[13px] text-small font-medium text-text-primary hover:border-border-strong-hover">
      Generate voiceover
      <span className="font-mono text-mono font-normal text-text-tertiary">{formatCredits(credits)} cr</span>
    </span>
  )
}

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
    <span className="flex h-[30px] flex-none cursor-pointer items-center gap-[8px] whitespace-nowrap rounded-control border border-border-strong bg-bg-inset px-[13px] text-small font-medium text-text-primary hover:border-border-strong-hover">
      Generate music
      <span className="font-mono text-mono font-normal text-text-tertiary">{formatCredits(credits)} cr</span>
    </span>
  )
}

export function VoiceoverSection({ language }: { language: string | null }) {
  return (
    <div
      data-testid="voiceover-section"
      className="flex flex-col gap-[10px] rounded-frame border border-border-subtle bg-bg-canvas p-[11px_14px]"
    >
      <div className="flex items-center gap-[10px]">
        <span className="flex flex-none items-center gap-[8px]">
          <span className="h-[13px] w-[2px] rounded-[1px] bg-ident-voiceover-fg" />
          <span className="text-label uppercase tracking-label text-ident-voiceover-fg">Voiceover</span>
        </span>
        <span className="flex-1 text-meta text-text-tertiary">Optional · pick a voice, or leave the film silent</span>
        <LanguagePicker language={language} />
      </div>
      <div className="flex flex-col gap-[9px]">
        <VoiceCards />
        <div className="flex items-center gap-[10px]">
          <span className="flex-1 text-meta text-text-tertiary">
            Auditioning voices is free — the samples are pre-rendered. You are charged once, when you generate.
          </span>
          <UploadButton />
          <GenerateVoiceoverButton />
        </div>
      </div>
    </div>
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

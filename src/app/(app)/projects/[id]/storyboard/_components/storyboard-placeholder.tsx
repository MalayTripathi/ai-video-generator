export function StoryboardPlaceholder() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-rc-md py-rc-md">
      <div
        data-testid="storyboard-placeholder"
        className="flex max-w-sm flex-col items-center gap-rc-2xs rounded-frame border border-dashed border-border-muted bg-bg-well px-rc-xl py-rc-2xl text-center"
      >
        <h2 className="text-section font-medium tracking-snug text-text-primary">Storyboard is coming soon</h2>
        <p className="text-ui text-text-secondary">
          This step will turn your image prompts into a narrated still-frame cut. It isn&rsquo;t available yet.
        </p>
      </div>
    </div>
  )
}

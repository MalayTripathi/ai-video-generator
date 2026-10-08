// "Edited by you": the prompt carries a hand edit. Shared by Step 3's card and the
// Storyboard inspect panel so both read identically.
export function EditedChip() {
  return (
    <span
      data-testid="edited-chip"
      className="flex-none rounded-badge bg-status-edited-bg px-2 py-[3px] text-chip font-medium text-status-edited-fg"
    >
      Edited by you
    </span>
  )
}

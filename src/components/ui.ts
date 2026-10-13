/** Shared Tailwind class sets for controls used across panels. */

export const btnPrimary = 'rounded-xl bg-accent px-[22px] py-3 font-bold text-accent-ink enabled:hover:brightness-106'
export const btnQuiet = 'rounded-xl border border-line bg-card px-5 py-[11px] font-semibold enabled:hover:border-ink-2'
export const link = 'font-semibold text-accent'
export const btnSmall = 'rounded-lg border border-line bg-card px-2.5 py-1 text-xs font-semibold'
export const btnGhost = 'rounded-lg border border-transparent px-2.5 py-1 text-xs font-semibold'

/** Segmented control: container and its buttons (use aria-pressed). */
export const seg = 'flex rounded-lg border border-line p-0.5'
export const segBtn = 'flex-1 rounded-md px-1.5 py-[5px] text-[13px] font-semibold text-ink-2 aria-pressed:bg-ink aria-pressed:text-card'

export const chip = 'inline-flex items-center gap-2 rounded-full border border-line bg-card py-[5px] pr-3 pl-[5px] text-[13px] font-medium enabled:hover:border-ink-2 disabled:opacity-100'
export const chipSmall = 'inline-flex items-center gap-2 rounded-full border border-line bg-card py-[3px] pr-2.5 pl-[3px] text-xs font-medium enabled:hover:border-ink-2'
export const swatch = 'rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.14)]'

/** A row in "More options". */
export const field = 'grid gap-1.5 border-b border-line px-3.5 py-3 [&_small]:text-xs'
export const fieldLabel = 'text-sm font-medium'
export const select = 'min-w-0 max-w-full rounded-lg border border-line bg-card px-2.5 py-[7px]'
export const note = 'text-xs text-ink-2'

export const progress = 'grid gap-1 text-xs text-ink-2'
export const bar = 'h-[5px] overflow-hidden rounded-[3px] bg-line'
export const barFill = 'h-full bg-accent transition-[width] duration-200'

export const spinner = 'size-4 flex-none animate-[spin_0.8s_linear_infinite] rounded-full border-[2.5px] border-line border-t-accent'
export const spinnerSmall = 'size-3 flex-none animate-[spin_0.8s_linear_infinite] rounded-full border-2 border-line border-t-accent'

export const check = 'flex cursor-pointer items-start gap-2.5 text-sm font-medium [&_input]:mt-[3px] [&_input]:accent-accent [&_small]:block [&_small]:text-xs [&_small]:font-normal'
export const range = 'w-full accent-accent'

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ')

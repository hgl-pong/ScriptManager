export interface RowLike {
  path: string
  name: string
  displayName: string
  tags: string[]
  lastRunAt: string
  lastExit: number | null
  lastDurationMs: number | null
}

export function typeLabel(type: string): string

export function filterRows<T extends RowLike>(view: T[], options?: { query?: string; tag?: string }): T[]

export function allTags(view: RowLike[]): string[]

export function formatLastRun(row: RowLike | null | undefined): string

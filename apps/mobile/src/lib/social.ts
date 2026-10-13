export type SamplePreferences = { liked: string[]; saved: string[]; following: string[] }
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(value.filter((item): item is string => typeof item === 'string' && item.length <= 100)),
      ].slice(0, 10000)
    : []
export function readPreferences(raw: string | null): SamplePreferences {
  if (!raw) return { liked: [], saved: [], following: [] }
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { liked: [], saved: [], following: [] }
  const value = parsed as Record<string, unknown>
  return { liked: strings(value.liked), saved: strings(value.saved), following: strings(value.following) }
}
export const savedKey = (owner?: string) => `clout:saved:${owner ?? 'guest'}`
export const toggleItem = (items: string[], id: string) =>
  items.includes(id) ? items.filter((value) => value !== id) : [...items, id]

/** Keep the preview catalog available when the API returns only hosted posts. */
export function mergePreviewFeed<T extends { id: string }>(preview: readonly T[], live: readonly T[]): T[] {
  const liveById = new Map(live.map((post) => [post.id, post]))
  const result = preview.map((post) => liveById.get(post.id) ?? post)
  const seen = new Set(result.map((post) => post.id))
  for (const post of live) {
    if (seen.has(post.id)) continue
    seen.add(post.id)
    result.push(post)
  }
  return result
}

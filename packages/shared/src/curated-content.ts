import catalog from '../../../apps/mobile/src/lib/curated-content.json' with { type: 'json' }
import archived from './archived-curated-content.json' with { type: 'json' }

/** Editorial source attribution; these publishers do not own the Clout demo markets. */
export type CuratedContent = {
  id: string
  creator: string
  caption: string
  tag: string
  video: string
  poster: string
  durationSeconds: number
  width?: number
  height?: number
  source: { url: string; handle: string; publishedAt: string }
}

// Keep the reviewed source catalog in one place while sharing it with API and provisioning.
export const curatedContent: readonly CuratedContent[] = catalog
/** Original source DTOs remain available; replacing the feed never rebinds their markets. */
export const originalCuratedContent: readonly CuratedContent[] = archived
export const archivedCuratedContent = originalCuratedContent.filter(
  (post) => !curatedContent.some((active) => active.id === post.id),
)
export const allCuratedContent: readonly CuratedContent[] = [...curatedContent, ...archivedCuratedContent]

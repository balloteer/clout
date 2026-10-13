import catalog from '../../../apps/mobile/src/lib/curated-content.json' with { type: 'json' }

/** Editorial source attribution; these publishers do not own the Clout demo markets. */
export type CuratedContent = {
  id: string
  creator: string
  caption: string
  tag: string
  video: string
  poster: string
  durationSeconds: number
  source: { url: string; handle: string; publishedAt: string }
}

// Keep the reviewed source catalog in one place while sharing it with API and provisioning.
export const curatedContent: readonly CuratedContent[] = catalog

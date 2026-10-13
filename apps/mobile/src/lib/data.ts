import { sampleContent } from '../../../../packages/shared/src/sample-content'
import { sampleMarkets } from '../../../../packages/shared/src/sample-markets'
import curatedContent from './curated-content.json'
import archivedContent from '../../../../packages/shared/src/archived-curated-content.json'
import type { CuratedContent } from '../../../../packages/shared/src/curated-content'
import { interleaveMarkets } from './catalog'

export type Post = {
  id: string
  creatorWallet?: string
  creator: string
  avatar: string
  caption: string
  tag: string
  color: string
  poster: string | number
  video: string | number
  videoFit?: 'cover' | 'contain'
  source?: { url: string; handle: string; publishedAt: string }
  likes: number
  comments: number
  views: string
  backers: number
  market: boolean
  sample: boolean
  duration: string
}
export const imageSource = (source: string | number) =>
  typeof source === 'string' ? { uri: source } : source

const sampleAssets: Record<string, { poster: number; video: number }> = {
  'sample-001': {
    poster: require('../../assets/media/sample-001.jpg'),
    video: require('../../assets/media/sample-001.mp4'),
  },
  'sample-002': {
    poster: require('../../assets/media/sample-002.jpg'),
    video: require('../../assets/media/sample-002.mp4'),
  },
  'sample-003': {
    poster: require('../../assets/media/sample-003.jpg'),
    video: require('../../assets/media/sample-003.mp4'),
  },
  'sample-004': {
    poster: require('../../assets/media/sample-004.jpg'),
    video: require('../../assets/media/sample-004.mp4'),
  },
  'sample-005': {
    poster: require('../../assets/media/sample-005.jpg'),
    video: require('../../assets/media/sample-005.mp4'),
  },
  'sample-006': {
    poster: require('../../assets/media/sample-006.jpg'),
    video: require('../../assets/media/sample-006.mp4'),
  },
  'sample-007': {
    poster: require('../../assets/media/sample-007.jpg'),
    video: require('../../assets/media/sample-007.mp4'),
  },
  'sample-008': {
    poster: require('../../assets/media/sample-008.jpg'),
    video: require('../../assets/media/sample-008.mp4'),
  },
  'sample-009': {
    poster: require('../../assets/media/sample-009.jpg'),
    video: require('../../assets/media/sample-009.mp4'),
  },
  'sample-010': {
    poster: require('../../assets/media/sample-010.jpg'),
    video: require('../../assets/media/sample-010.mp4'),
  },
  'sample-011': {
    poster: require('../../assets/media/sample-011.jpg'),
    video: require('../../assets/media/sample-011.mp4'),
  },
  'sample-012': {
    poster: require('../../assets/media/sample-012.jpg'),
    video: require('../../assets/media/sample-012.mp4'),
  },
  'sample-013': {
    poster: require('../../assets/media/sample-013.jpg'),
    video: require('../../assets/media/sample-013.mp4'),
  },
  'sample-014': {
    poster: require('../../assets/media/sample-014.jpg'),
    video: require('../../assets/media/sample-014.mp4'),
  },
  'sample-015': {
    poster: require('../../assets/media/sample-015.jpg'),
    video: require('../../assets/media/sample-015.mp4'),
  },
  'sample-016': {
    poster: require('../../assets/media/sample-016.jpg'),
    video: require('../../assets/media/sample-016.mp4'),
  },
  'sample-017': {
    poster: require('../../assets/media/sample-017.jpg'),
    video: require('../../assets/media/sample-017.mp4'),
  },
  'sample-018': {
    poster: require('../../assets/media/sample-018.jpg'),
    video: require('../../assets/media/sample-018.mp4'),
  },
  'sample-019': {
    poster: require('../../assets/media/sample-019.jpg'),
    video: require('../../assets/media/sample-019.mp4'),
  },
  'sample-020': {
    poster: require('../../assets/media/sample-020.jpg'),
    video: require('../../assets/media/sample-020.mp4'),
  },
  'sample-021': {
    poster: require('../../assets/media/sample-021.jpg'),
    video: require('../../assets/media/sample-021.mp4'),
  },
  'sample-022': {
    poster: require('../../assets/media/sample-022.jpg'),
    video: require('../../assets/media/sample-022.mp4'),
  },
  'sample-023': {
    poster: require('../../assets/media/sample-023.jpg'),
    video: require('../../assets/media/sample-023.mp4'),
  },
  'sample-024': {
    poster: require('../../assets/media/sample-024.jpg'),
    video: require('../../assets/media/sample-024.mp4'),
  },
  'sample-025': {
    poster: require('../../assets/media/sample-025.jpg'),
    video: require('../../assets/media/sample-025.mp4'),
  },
  'sample-026': {
    poster: require('../../assets/media/sample-026.jpg'),
    video: require('../../assets/media/sample-026.mp4'),
  },
  'sample-027': {
    poster: require('../../assets/media/sample-027.jpg'),
    video: require('../../assets/media/sample-027.mp4'),
  },
  'sample-028': {
    poster: require('../../assets/media/sample-028.jpg'),
    video: require('../../assets/media/sample-028.mp4'),
  },
  'sample-029': {
    poster: require('../../assets/media/sample-029.jpg'),
    video: require('../../assets/media/sample-029.mp4'),
  },
  'sample-030': {
    poster: require('../../assets/media/sample-030.jpg'),
    video: require('../../assets/media/sample-030.mp4'),
  },
  'sample-031': {
    poster: require('../../assets/media/sample-031.jpg'),
    video: require('../../assets/media/sample-031.mp4'),
  },
  'sample-032': {
    poster: require('../../assets/media/sample-032.jpg'),
    video: require('../../assets/media/sample-032.mp4'),
  },
  'sample-033': {
    poster: require('../../assets/media/sample-033.jpg'),
    video: require('../../assets/media/sample-033.mp4'),
  },
  'sample-034': {
    poster: require('../../assets/media/sample-034.jpg'),
    video: require('../../assets/media/sample-034.mp4'),
  },
  'sample-035': {
    poster: require('../../assets/media/sample-035.jpg'),
    video: require('../../assets/media/sample-035.mp4'),
  },
  'sample-036': {
    poster: require('../../assets/media/sample-036.jpg'),
    video: require('../../assets/media/sample-036.mp4'),
  },
  'sample-037': {
    poster: require('../../assets/media/sample-037.jpg'),
    video: require('../../assets/media/sample-037.mp4'),
  },
  'sample-038': {
    poster: require('../../assets/media/sample-038.jpg'),
    video: require('../../assets/media/sample-038.mp4'),
  },
  'sample-039': {
    poster: require('../../assets/media/sample-039.jpg'),
    video: require('../../assets/media/sample-039.mp4'),
  },
  'sample-040': {
    poster: require('../../assets/media/sample-040.jpg'),
    video: require('../../assets/media/sample-040.mp4'),
  },
  'sample-041': {
    poster: require('../../assets/media/sample-041.jpg'),
    video: require('../../assets/media/sample-041.mp4'),
  },
  'sample-042': {
    poster: require('../../assets/media/sample-042.jpg'),
    video: require('../../assets/media/sample-042.mp4'),
  },
  'sample-043': {
    poster: require('../../assets/media/sample-043.jpg'),
    video: require('../../assets/media/sample-043.mp4'),
  },
  'sample-044': {
    poster: require('../../assets/media/sample-044.jpg'),
    video: require('../../assets/media/sample-044.mp4'),
  },
  'sample-045': {
    poster: require('../../assets/media/sample-045.jpg'),
    video: require('../../assets/media/sample-045.mp4'),
  },
  'sample-046': {
    poster: require('../../assets/media/sample-046.jpg'),
    video: require('../../assets/media/sample-046.mp4'),
  },
  'sample-047': {
    poster: require('../../assets/media/sample-047.jpg'),
    video: require('../../assets/media/sample-047.mp4'),
  },
  'sample-048': {
    poster: require('../../assets/media/sample-048.jpg'),
    video: require('../../assets/media/sample-048.mp4'),
  },
  'sample-049': {
    poster: require('../../assets/media/sample-049.jpg'),
    video: require('../../assets/media/sample-049.mp4'),
  },
  'sample-050': {
    poster: require('../../assets/media/sample-050.jpg'),
    video: require('../../assets/media/sample-050.mp4'),
  },
}
const curatedPost = (post: CuratedContent, archived = false): Post => ({
  id: post.id,
  creatorWallet: sampleMarkets[post.id]?.creatorWallet,
  creator: post.creator,
  avatar: post.creator.charAt(0),
  caption: post.caption,
  tag: post.tag,
  color: post.tag === 'Solana' ? '#C6FF3D' : post.tag === 'SKR' ? '#FF3D8B' : '#3DB8FF',
  poster: post.poster,
  video: post.video,
  videoFit: archived ? 'contain' : 'cover',
  source: post.source,
  likes: 0,
  comments: 0,
  views: '',
  backers: 0,
  market: !!sampleMarkets[post.id],
  sample: true,
  duration: `${Math.floor(post.durationSeconds / 60)}:${String(Math.floor(post.durationSeconds) % 60).padStart(2, '0')}`,
})
export const curatedPosts = curatedContent.map((post) => curatedPost(post))
// Retired picks stay available to saved collections and existing market holders.
export const archivedPosts = archivedContent
  .filter((post) => !curatedContent.some((active) => active.id === post.id))
  .map((post) => curatedPost(post, true))
const bundledPosts: Post[] = sampleContent.map((post) => {
  const market = sampleMarkets[post.id]
  const asset = sampleAssets[post.videoFile.replace('.mp4', '')]
  return {
    id: post.id,
    creatorWallet: market?.creatorWallet ?? post.creatorWallet,
    creator: post.creator,
    avatar: post.avatar,
    caption: post.caption,
    tag: post.tag,
    color: post.color,
    ...asset,
    likes: 0,
    comments: 0,
    views: '',
    backers: 0,
    market: !!market,
    sample: true,
    duration: `0:${String(post.durationSeconds).padStart(2, '0')}`,
  }
})
export const samplePosts: Post[] = interleaveMarkets([...curatedPosts, ...bundledPosts])
export const allCatalogPosts = [...samplePosts, ...archivedPosts]
export const sampleComments: Record<string, { id: string; name: string; text: string }[]> = {}
export const mediaCredits =
  `${curatedContent.length} portrait videos from public X posts about Solana, SKR and AI. Publisher attribution, original date and source link accompany each video; source playback requires internet. Earlier picks remain available in saved collections. These creators have not endorsed Clout. ` +
  '50 licensed sample excerpts from Big Buck Bunny (© 2008 Blender Foundation / www.bigbuckbunny.org) and Sintel (© 2010 Blender Foundation / www.sintel.org), CC BY 3.0; and Caminandes: Gran Dillama (© 2013 Blender Foundation / Blender Studio; director Pablo Vazquez), CC BY 4.0. Clips shortened, cropped and resized; posters extracted from the clips. Sample labels are editorial, not creator wallets or registered .skr names. No social counts are invented. Full credits and source intervals: assets/media/CREDITS.md.'

/** Licensed, distinct excerpts. These are editorial samples, not creator accounts. */
export const sampleFilms = {
  bunny: {
    title: 'Big Buck Bunny',
    creatorWallet: 'demo-blender',
    creator: 'Bunny · sample',
    avatar: 'B',
    tag: 'Animation',
    color: '#C6FF3D',
    credit: '© 2008 Blender Foundation / www.bigbuckbunny.org',
    license: 'CC BY 3.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/3.0/',
    sourcePage: 'https://peach.blender.org/about/',
  },
  sintel: {
    title: 'Sintel',
    creatorWallet: 'demo-openfilm',
    creator: 'Sintel · sample',
    avatar: 'S',
    tag: 'Cinema',
    color: '#FF3D8B',
    credit: '© 2010 Blender Foundation / www.sintel.org',
    license: 'CC BY 3.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/3.0/',
    sourcePage: 'https://durian.blender.org/sharing/',
  },
  caminandes: {
    title: 'Caminandes: Gran Dillama',
    creatorWallet: 'demo-caminandes',
    creator: 'Caminandes · sample',
    avatar: 'C',
    tag: 'Comedy',
    color: '#3DB8FF',
    credit: '© 2013 Blender Foundation / Blender Studio. Directed by Pablo Vazquez.',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    sourcePage: 'https://studio.blender.org/projects/caminandes-2/gallery/?asset=2363',
  },
} as const

export type SampleFilm = keyof typeof sampleFilms
export type SampleContent = {
  id: string
  ordinal: number
  film: SampleFilm
  title: string
  caption: string
  creatorWallet: string
  creator: string
  avatar: string
  tag: string
  color: string
  credit: string
  license: string
  licenseUrl: string
  sourcePage: string
  sourceStartSeconds: number
  durationSeconds: number
  posterSeconds: number
  cropPosition: number
  videoFile: string
  posterFile: string
}

const excerpts: {
  film: SampleFilm
  start: number
  caption: string
  duration?: number
  poster?: number
  crop?: number
}[] = [
  { film: 'bunny', start: 400, caption: 'A little peace and quiet. Big Buck Bunny · 01' },
  { film: 'sintel', start: 64, caption: 'Every adventure starts somewhere. Sintel · 01' },
  { film: 'caminandes', start: 10, duration: 5, caption: 'One very determined llama. Caminandes · 01' },
  { film: 'bunny', start: 78, caption: 'Taking the scenic route. Big Buck Bunny · 02' },
  { film: 'sintel', start: 98, caption: 'A world worth exploring. Sintel · 02' },
  { film: 'caminandes', start: 15, caption: 'A small problem on a big day. Caminandes · 02' },
  { film: 'bunny', start: 101, caption: 'Nature has other plans. Big Buck Bunny · 03' },
  { film: 'sintel', start: 132, caption: 'Follow the next chapter. Sintel · 03' },
  { film: 'caminandes', start: 25, caption: 'The grass looks greener over there. Caminandes · 03' },
  { film: 'bunny', start: 124, caption: 'When the forest gets interesting. Big Buck Bunny · 04' },
  { film: 'sintel', start: 166, caption: 'A little courage goes a long way. Sintel · 04' },
  { film: 'caminandes', start: 35, caption: 'There must be a way through. Caminandes · 04' },
  { film: 'bunny', start: 147, caption: 'A perfectly ordinary afternoon. Big Buck Bunny · 05' },
  { film: 'sintel', start: 200, caption: 'Stories are made of small moments. Sintel · 05' },
  { film: 'caminandes', start: 45, caption: 'A new plan is forming. Caminandes · 05' },
  { film: 'bunny', start: 170, caption: 'The quiet never lasts. Big Buck Bunny · 06' },
  { film: 'sintel', start: 234, caption: 'Keep the adventure moving. Sintel · 06' },
  { film: 'caminandes', start: 55, caption: 'Persistence, llama edition. Caminandes · 06' },
  { film: 'bunny', start: 193, caption: 'A forest full of personalities. Big Buck Bunny · 07' },
  { film: 'sintel', start: 268, caption: 'Finding a little connection. Sintel · 07' },
  { film: 'caminandes', start: 65, caption: 'Nothing is ever that simple. Caminandes · 07' },
  { film: 'bunny', start: 216, caption: 'The afternoon takes a turn. Big Buck Bunny · 08' },
  { film: 'sintel', start: 302, caption: 'The journey keeps unfolding. Sintel · 08' },
  { film: 'caminandes', start: 75, caption: 'Trying a different angle. Caminandes · 08' },
  { film: 'bunny', start: 239, caption: 'Waiting for the right moment. Big Buck Bunny · 09' },
  { film: 'sintel', start: 336, caption: 'A moment from another world. Sintel · 09' },
  { film: 'caminandes', start: 85, caption: 'The snack quest continues. Caminandes · 09' },
  { film: 'bunny', start: 262, caption: 'Things are getting animated. Big Buck Bunny · 10' },
  { film: 'sintel', start: 370, caption: 'A story beyond the horizon. Sintel · 10' },
  { film: 'caminandes', start: 95, poster: 0.5, caption: 'Never underestimate a llama. Caminandes · 10' },
  { film: 'bunny', start: 285, caption: 'Time for a little improvisation. Big Buck Bunny · 11' },
  { film: 'sintel', start: 404, caption: 'Into the next scene. Sintel · 11' },
  { film: 'bunny', start: 308, caption: 'A change of pace. Big Buck Bunny · 12' },
  { film: 'sintel', start: 438, caption: 'Adventure is in the details. Sintel · 12' },
  { film: 'bunny', start: 331, caption: 'The plan starts coming together. Big Buck Bunny · 13' },
  { film: 'sintel', start: 472, caption: 'Looking a little further. Sintel · 13' },
  { film: 'bunny', start: 354, caption: 'Small creatures, big energy. Big Buck Bunny · 14' },
  { film: 'sintel', start: 506, caption: 'Keep following the story. Sintel · 14' },
  { film: 'bunny', start: 377, caption: 'Not your average woodland walk. Big Buck Bunny · 15' },
  { film: 'sintel', start: 540, caption: 'The world opens up. Sintel · 15' },
  { film: 'bunny', start: 55, caption: 'A little cartoon chaos. Big Buck Bunny · 16' },
  { film: 'sintel', start: 574, caption: 'The search continues. Sintel · 16' },
  { film: 'bunny', start: 423, caption: 'Another twist in the trees. Big Buck Bunny · 17' },
  { film: 'sintel', start: 608, caption: 'Some stories stay with you. Sintel · 17' },
  { film: 'bunny', start: 446, caption: 'Everything is in motion. Big Buck Bunny · 18' },
  { film: 'sintel', start: 642, caption: 'A turning point. Sintel · 18' },
  { film: 'bunny', start: 469, caption: 'One more woodland surprise. Big Buck Bunny · 19' },
  { film: 'sintel', start: 700, caption: 'A moment to remember. Sintel · 19' },
  { film: 'bunny', start: 40, caption: 'The forest has the last word. Big Buck Bunny · 20' },
  {
    film: 'sintel',
    start: 710,
    poster: 0.5,
    crop: 0.35,
    caption: 'The adventure leaves its mark. Sintel · 20',
  },
]

export const sampleContent: SampleContent[] = excerpts.map((excerpt, index) => {
  const ordinal = index + 1
  const asset = `sample-${String(ordinal).padStart(3, '0')}`
  const film = sampleFilms[excerpt.film]
  return {
    ...film,
    id: index === 0 ? 'big-buck-bunny' : index === 1 ? 'sintel' : asset,
    ordinal,
    film: excerpt.film,
    caption: excerpt.caption,
    sourceStartSeconds: excerpt.start,
    durationSeconds: excerpt.duration ?? 10,
    posterSeconds: excerpt.poster ?? 3,
    cropPosition: excerpt.crop ?? 0.5,
    videoFile: `${asset}.mp4`,
    posterFile: `${asset}.jpg`,
  }
})

export const sampleMediaPath = (filename: string) => `/v1/samples/media/${filename}`

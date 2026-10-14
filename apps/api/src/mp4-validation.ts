import { open, stat } from 'node:fs/promises'

const MAX_TOP_LEVEL_BOXES = 1_024
const MAX_MOOV_BOXES = 4_096

async function readBox(
  file: Awaited<ReturnType<typeof open>>,
  offset: number,
  limit: number,
): Promise<{ type: string; start: number; end: number } | null> {
  if (offset + 8 > limit) return null
  const header = Buffer.alloc(16)
  await file.read(header, 0, 8, offset)
  let size = Number(header.readUInt32BE(0))
  const type = header.subarray(4, 8).toString('ascii')
  let headerSize = 8
  if (size === 1) {
    if (offset + 16 > limit) return null
    await file.read(header, 8, 8, offset + 8)
    const large = header.readBigUInt64BE(8)
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null
    size = Number(large)
    headerSize = 16
  } else if (size === 0) size = limit - offset
  if (size < headerSize || offset + size > limit) return null
  return { type, start: offset + headerSize, end: offset + size }
}

export async function mp4DurationSeconds(path: string): Promise<number | null> {
  const info = await stat(path)
  const file = await open(path, 'r')
  try {
    let offset = 0
    let topLevelBoxes = 0
    let durationSeconds: number | null = null
    let hasVideoTrack = false
    let hasMediaData = false
    while (offset < info.size) {
      if (++topLevelBoxes > MAX_TOP_LEVEL_BOXES) return null
      const box = await readBox(file, offset, info.size)
      if (!box) return null
      if (box.type === 'mdat' && box.end > box.start) hasMediaData = true
      if (box.type === 'moov') {
        let childOffset = box.start
        let childBoxes = 0
        while (childOffset < box.end) {
          if (++childBoxes > MAX_MOOV_BOXES) return null
          const child = await readBox(file, childOffset, box.end)
          if (!child) return null
          if (child.type === 'trak' && (await trackHasVideoHandler(file, child))) hasVideoTrack = true
          if (child.type === 'mvhd') {
            const data = Buffer.alloc(32)
            const length = Math.min(data.length, child.end - child.start)
            await file.read(data, 0, length, child.start)
            const version = data[0]
            if (version !== 0 && version !== 1) return null
            const timescaleOffset = version === 1 ? 20 : 12
            const durationOffset = version === 1 ? 24 : 16
            if (length < durationOffset + (version === 1 ? 8 : 4)) return null
            const timescale = data.readUInt32BE(timescaleOffset)
            if (!timescale) return null
            const duration =
              version === 1 ? data.readBigUInt64BE(durationOffset) : BigInt(data.readUInt32BE(durationOffset))
            durationSeconds = Number(duration) / timescale
          }
          childOffset = child.end
        }
      }
      offset = box.end
    }
    return hasVideoTrack && hasMediaData ? durationSeconds : null
  } finally {
    await file.close()
  }
}

async function trackHasVideoHandler(
  file: Awaited<ReturnType<typeof open>>,
  track: { start: number; end: number },
): Promise<boolean> {
  let trackOffset = track.start
  let boxes = 0
  while (trackOffset < track.end) {
    if (++boxes > MAX_MOOV_BOXES) return false
    const trackChild = await readBox(file, trackOffset, track.end)
    if (!trackChild) return false
    if (trackChild.type === 'mdia') {
      let mediaOffset = trackChild.start
      while (mediaOffset < trackChild.end) {
        if (++boxes > MAX_MOOV_BOXES) return false
        const mediaChild = await readBox(file, mediaOffset, trackChild.end)
        if (!mediaChild) return false
        if (mediaChild.type === 'hdlr') {
          if (mediaChild.end - mediaChild.start < 12) return false
          const data = Buffer.alloc(12)
          const { bytesRead } = await file.read(data, 0, data.length, mediaChild.start)
          if (bytesRead !== data.length) return false
          return data.subarray(8, 12).toString('ascii') === 'vide'
        }
        mediaOffset = mediaChild.end
      }
    }
    trackOffset = trackChild.end
  }
  return false
}

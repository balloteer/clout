#!/usr/bin/env python3
"""Reproduce the 50 licensed portrait excerpts. Requires Node/tsx and FFmpeg 7+."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.tooling/media-sources'
OUTPUT = ROOT / 'apps/mobile/assets/media'
SOURCES = {
    'bunny': {
        'url': 'https://download.blender.org/peach/bigbuckbunny_movies/big_buck_bunny_720p_h264.mov.zip',
        'archive': 'bunny-original.zip', 'file': 'bunny.mov',
        'sha256': 'b0c9ade80b086179feee41514929de583966eec87c703575d97f051f88b33b67',
    },
    'sintel': {
        'url': 'https://download.blender.org/demo/movies/Sintel.2010.720p.mkv.zip',
        'archive': 'sintel.zip', 'file': 'sintel.mkv',
        'sha256': '4f013b146ec6480813b1a515bfb96a2ae3e350644e4338373b8365a06a024b84',
    },
    'caminandes': {
        'url': 'https://download.blender.org/demo/movies/caminandes_gran_dillama.mp4.zip',
        'archive': 'caminandes.zip', 'file': 'caminandes.mp4',
        'sha256': '2e54abfb18dcb0a25d41e7b5d97fd51b226cec58d2fbcad101cf6deecea8c48b',
    },
}


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def source_file(name, download):
    source = SOURCES[name]
    target = CACHE / source['file']
    if target.exists() and not download:
        return target
    archive = CACHE / source['archive']
    if not archive.exists():
        if not download:
            raise RuntimeError(f'Missing {target}; rerun with --download')
        print(f'Downloading {name}', flush=True)
        urllib.request.urlretrieve(source['url'], archive)
    if not source['sha256'] or digest(archive) != source['sha256']:
        raise RuntimeError(f'Source archive checksum mismatch: {archive}')
    with zipfile.ZipFile(archive) as bundle:
        member = next(n for n in bundle.namelist()
                      if n.endswith(('.mp4', '.mkv', '.mov')) and not n.startswith('__MACOSX'))
        with bundle.open(member) as incoming, target.open('wb') as outgoing:
            shutil.copyfileobj(incoming, outgoing)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true', help='Fetch/check official source archives')
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--only', help='With --force, re-encode these comma-separated catalog ordinals')
    args = parser.parse_args()
    only = {int(value) for value in args.only.split(',')} if args.only else None
    ffmpeg = os.environ.get('CLOUT_FFMPEG') or shutil.which('ffmpeg')
    if not ffmpeg:
        local = list((ROOT / '.tooling').glob('media-python/lib/python*/site-packages/imageio_ffmpeg/binaries/ffmpeg-*'))
        ffmpeg = str(local[0]) if local else None
    if not ffmpeg:
        raise RuntimeError('Install FFmpeg 7+ or set CLOUT_FFMPEG to its executable')
    CACHE.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    catalog = json.loads(subprocess.check_output([
        'node', '--import', 'tsx', '--input-type=module', '-e',
        "import {sampleContent} from './packages/shared/src/sample-content.ts'; console.log(JSON.stringify(sampleContent))",
    ], cwd=ROOT))
    assert len(catalog) == 50 and len({p['id'] for p in catalog}) == 50
    sources = {name: source_file(name, args.download) for name in SOURCES}

    def encode(post):
        video = OUTPUT / post['videoFile']
        poster = OUTPUT / post['posterFile']
        regenerate = args.force and (only is None or post['ordinal'] in only)
        if regenerate or not video.exists():
            temporary = CACHE / post['videoFile']
            subprocess.run([
                ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                '-ss', str(post['sourceStartSeconds']), '-i', str(sources[post['film']]),
                '-t', str(post['durationSeconds']), '-map', '0:v:0', '-map', '0:a:0?',
                '-vf', f"scale=-2:1068,crop=480:1068:(in_w-out_w)*{post['cropPosition']}:0,setsar=1,fps=24",
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-threads', '2',
                '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-ac', '2',
                '-movflags', '+faststart', '-map_metadata', '-1',
                '-metadata', f"comment={post['credit']}; {post['license']}; excerpt cropped and resized by Clout",
                str(temporary),
            ], check=True)
            temporary.replace(video)
        if regenerate or not poster.exists():
            subprocess.run([
                ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                '-ss', str(post['posterSeconds']), '-i', str(video), '-frames:v', '1', '-q:v', '3', str(poster),
            ], check=True)
        # Decode both streams, so corrupted/truncated clips cannot silently enter the catalog.
        subprocess.run([ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error',
                        '-i', str(video), '-f', 'null', '-'], check=True)
        record = {**post, 'videoSha256': digest(video), 'posterSha256': digest(poster),
                  'videoBytes': video.stat().st_size, 'posterBytes': poster.stat().st_size,
                  'width': 480, 'height': 1068, 'fps': 24}
        print(f"Verified {post['ordinal']:02d}/50 {video.name}", flush=True)
        return record

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(args.workers, 8))) as pool:
        manifest = list(pool.map(encode, catalog))
    assert len({p['videoSha256'] for p in manifest}) == 50, 'Repeated video files'
    assert len({p['posterSha256'] for p in manifest}) == 50, 'Repeated poster files'
    (OUTPUT / 'sample-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f"50 distinct clips validated; {sum(p['videoBytes'] + p['posterBytes'] for p in manifest):,} bytes", flush=True)


if __name__ == '__main__':
    main()

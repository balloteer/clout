# Licensed sample footage

The app bundles **50 distinct portrait excerpts**: 20 from Big Buck Bunny, 20 from Sintel, and 10 from Caminandes: Gran Dillama. Forty-nine excerpts are ten seconds; the opening Caminandes excerpt is five seconds to exclude its title. Source intervals do not overlap within a film. The 100 video/poster files total approximately 34 MB.

| Film | Required attribution | License and official source |
| --- | --- | --- |
| Big Buck Bunny | © copyright 2008, Blender Foundation / www.bigbuckbunny.org | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/); [Peach license and attribution](https://peach.blender.org/about/) |
| Sintel | © copyright 2010, Blender Foundation / www.sintel.org | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/); [Sintel sharing policy](https://durian.blender.org/sharing/) |
| Caminandes: Gran Dillama | © 2013 Blender Foundation / Blender Studio. Director: Pablo Vazquez. Producer: Francesco Siddi. Writer: Beorn Leonard. Music and sound: Jan Morgenstern. | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); [official film asset and license](https://studio.blender.org/projects/caminandes-2/gallery/?asset=2363); [full credits](https://studio.blender.org/projects/caminandes-2/pages/credits/) |

Caminandes uses the **current license on the official film asset 2363**, which is CC BY 4.0. The exact asset's license can also be read in the [official asset detail](https://studio.blender.org/projects/api/assets/2363/?site_context=featured_artwork). Big Buck Bunny uses the original 720p film, not the later Sunflower remaster. Audio remains combined with the film excerpts; the separately distributed music score is not used.

Clout modifications: extracts shortened, center-cropped and resized to **480 × 1068 (40:89)**, encoded as H.264/AAC at 24 fps; poster JPGs extracted from their matching clips. No AI-generated imagery or replacement audio is used. The original films are wider than the portrait screen, so cropping changes the composition. Captions and “sample” creator labels are editorial demonstration content, not claims of authorship, endorsement, registered .skr names, or wallet ownership. Social counts start at zero and use actual app activity thereafter.

Devnet markets can be attached to these posts independently of their sample-footage status. These test tokens do not convey rights in the underlying films. Film credits and licenses remain attached to the content.

## Reproduce and verify

Run `python3 scripts/seed-content.py --download --force` from the repository root with Node dependencies installed and FFmpeg 7+ on PATH, or set `CLOUT_FFMPEG` to its executable. Source downloads are confined to the gitignored `.tooling/media-sources/` directory. The script checks SHA-256 hashes of official Blender archives before extraction, encodes up to four clips in parallel, decodes every output, and rejects repeated video/poster hashes.

The canonical [catalog](../../../../packages/shared/src/sample-content.ts) contains every ID, source interval, license, caption, and filename. [sample-manifest.json](sample-manifest.json) records exact output hashes, sizes, dimensions, and poster timestamps. The API serves only these catalog filenames, with GET/HEAD and byte-range support for video seeking.

The older `bunny.mp4`, `sintel.mp4`, and `chaos.mp4` trailer excerpts remain as prior artifacts, but current app code does not reference or bundle them. Their original trailer sources were [Bunny](https://media.w3.org/2010/05/bunny/trailer.mp4) and [Sintel](https://media.w3.org/2010/05/sintel/trailer.mp4), under the corresponding film licenses above.

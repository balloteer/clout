# Curated portrait videos

The active preview catalog contains **12 reviewed portrait videos**: three Seeker/SKR, two Solana and seven AI posts, ahead of the 50 bundled licensed sample clips. The former 18 landscape/square curated posts are archived from the public feed. Their original IDs, media attribution and existing market bindings are preserved; replacement videos receive new source-based IDs and separate devnet markets.

The selection favors close-up unboxings, captioned creator demonstrations, event footage and short visual stories. AI-generated scenes and presenters are identified in the editorial captions. Source publishers are not represented as owners or endorsers of Clout-operated demo markets. Social engagement is not invented; any demo trading is labeled and comes from recorded devnet transactions.

All 12 selected MP4 renditions were downloaded for review on October 13, 2026 and measured with ffprobe. Every one is native **9:16**, at least **720×1280**, H.264 with AAC audio, and under 57 seconds. Contact sheets sampled the footage across each clip; portrait containers with embedded landscape videos, dense prompt panels or blurred padding were rejected. The Seeker 40:89 display uses a centered cover crop; important subjects stay near the middle. Original media files are not altered.

| Topic  | Publisher      | Stream size | Duration | Published  | Source                                                                    |
| ------ | -------------- | ----------- | -------- | ---------- | ------------------------------------------------------------------------- |
| SKR    | Airforcetuan   | 1080×1920   | 56.3s    | 2025-11-19 | [Original post](https://x.com/airforcetuanNFT/status/1991160618393506023) |
| AI     | Kling AI       | 720×1280    | 13.1s    | 2026-09-11 | [Original post](https://x.com/Kling_ai/status/2098379694240338135)        |
| AI     | Pika           | 720×1280    | 15.1s    | 2026-05-01 | [Original post](https://x.com/pika_labs/status/2050294298487529676)       |
| AI     | Alexis Ohanian | 720×1280    | 32.7s    | 2025-11-17 | [Original post](https://x.com/alexisohanian/status/1990540514832363659)   |
| AI     | Kling AI       | 720×1280    | 49.7s    | 2026-07-01 | [Original post](https://x.com/Kling_ai/status/2072350860005523456)        |
| AI     | Kling AI       | 720×1280    | 30.3s    | 2026-08-08 | [Original post](https://x.com/Kling_ai/status/2086105153409626451)        |
| AI     | Pika           | 720×1280    | 15.1s    | 2026-05-02 | [Original post](https://x.com/pika_labs/status/2050392913226633576)       |
| AI     | Kling AI       | 720×1280    | 19.8s    | 2026-06-13 | [Original post](https://x.com/Kling_ai/status/2065811435892924604)        |
| Solana | Solflare       | 720×1280    | 17.8s    | 2026-08-27 | [Original post](https://x.com/solflare/status/2092953519162794455)        |
| SKR    | vana           | 720×1280    | 35.2s    | 2026-09-01 | [Original post](https://x.com/coinempress/status/2094722038090871169)     |
| SKR    | Oshzone        | 720×1280    | 18.1s    | 2025-12-30 | [Original post](https://x.com/OshzoneW/status/2005940485718958128)        |
| Solana | SolanaFloor    | 720×1280    | 47.6s    | 2026-10-06 | [Original post](https://x.com/SolanaFloor/status/2107505136323219524)     |

Catalog: `apps/mobile/src/lib/curated-content.json`. The numeric `width`, `height` and `durationSeconds` fields describe the selected MP4 rendition, rather than the publisher's potentially larger original upload. Source metadata comes from X's public syndication response. Each post retains its original publisher handle, URL and publication date.

Videos stream from the original X media CDN; they are not bundled or rehosted. Network access is required, and removed media can be retried or opened through the original-post link. The visible date distinguishes historical announcements. The comment action opens the original conversation. The 50 bundled licensed samples remain available as offline content.

The web HTML template includes a `no-referrer` policy before media loads: the source CDN rejects requests carrying a localhost referrer. This also avoids exposing app navigation URLs to external media hosts. Browser verification checks actual playback, not only successful metadata requests.

Review evidence is kept locally under ignored `artifacts/portrait-review/`: original metadata JSON, exact downloaded renditions, ffprobe JSON and contact sheets. Public availability does not establish a redistribution license; production distribution should use the creators' permitted integration or authorization.

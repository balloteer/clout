# Curated preview videos

The preview catalog includes 18 public videos: six Solana, six SKR and six AI posts. They appear in alternating topics ahead of the 50 bundled sample clips. All 68 videos now have finalized mock-SKR devnet markets, preserving the original 30 registrations. The curated videos use real Clout-operated demo markets; their source publishers are not represented as market owners or endorsers. Imported social counts are not invented. Likes and follows are local preview preferences.

Videos stream from the original X media CDN; they are not bundled or rehosted. Every video and poster returned HTTP 200 during the October 13, 2026 source check. Network access is required; removed media can be retried or opened via its original-post link. Original aspect ratios are contained within the Seeker 40:89 frame. A visible date distinguishes historical announcements. The comment action opens the original conversation.

| Topic  | Publisher              | Video                                        | Published  | Source                                                                 |
| ------ | ---------------------- | -------------------------------------------- | ---------- | ---------------------------------------------------------------------- |
| Solana | Solana                 | Anatoly on Solana’s early growth             | 2025-10-31 | [Original post](https://x.com/solana/status/1984048092786860037)       |
| SKR    | Seeker / Solana Mobile | SKR allocation checker reveal                | 2026-01-14 | [Original post](https://x.com/solanamobile/status/2011476349597229548) |
| AI     | Andrej Karpathy        | Karpathy’s generated 3D world                | 2026-08-02 | [Original post](https://x.com/karpathy/status/2083749667410727319)     |
| Solana | Solana                 | Anatoly previews Alpenglow                   | 2025-11-03 | [Original post](https://x.com/solana/status/1985363167153647945)       |
| SKR    | Seeker / Solana Mobile | SKR launches                                 | 2026-01-21 | [Original post](https://x.com/solanamobile/status/2013794341614166152) |
| AI     | Andrew Ng              | Andrew Ng introduces OpenWorker              | 2026-07-23 | [Original post](https://x.com/AndrewYNg/status/2080333504446108104)    |
| Solana | Solana                 | Mert on the Solana developer community       | 2023-10-13 | [Original post](https://x.com/solana/status/1712853175898878273)       |
| SKR    | Seeker / Solana Mobile | MONOLITH mobile hackathon                    | 2026-02-02 | [Original post](https://x.com/solanamobile/status/2018381131914084654) |
| AI     | Andrew Ng              | Andrew Ng introduces Agentic AI              | 2025-10-07 | [Original post](https://x.com/AndrewYNg/status/1975614372799283423)    |
| Solana | mert                   | Mert introduces the Helius Startup Launchpad | 2024-12-30 | [Original post](https://x.com/mert/status/1873788725312049528)         |
| SKR    | Seeker / Solana Mobile | Meet Solana Seeker                           | 2024-09-19 | [Original post](https://x.com/solanamobile/status/1836614409613119632) |
| AI     | Jim Fan                | Jim Fan introduces DreamGen                  | 2025-05-20 | [Original post](https://x.com/DrJimFan/status/1924819887139987855)     |
| Solana | Solana                 | Kevin Bowers announces Frankendancer         | 2024-09-20 | [Original post](https://x.com/solana/status/1837035324587028567)       |
| SKR    | Seeker / Solana Mobile | The SKR countdown                            | 2025-12-03 | [Original post](https://x.com/solanamobile/status/1996278509967434017) |
| AI     | Jim Fan                | Robots learn athletic motion                 | 2025-02-04 | [Original post](https://x.com/DrJimFan/status/1886824152272920642)     |
| Solana | Solana                 | Solana and Google Cloud announcement         | 2026-05-05 | [Original post](https://x.com/solana/status/2051700526002176027)       |
| SKR    | Seeker / Solana Mobile | Solana Mobile expands its hardware reach     | 2025-12-13 | [Original post](https://x.com/solanamobile/status/1999757861610750407) |
| AI     | Jim Fan                | Sora imagines Minecraft                      | 2024-02-16 | [Original post](https://x.com/DrJimFan/status/1758351203292111288)     |

Catalog: `apps/mobile/src/lib/curated-content.json`. Source metadata was verified through X's public syndication endpoint. Editorial captions summarize each post. Public availability does not establish a redistribution license; production distribution should use the creators' permitted integration or authorization.

The web HTML template sets `Referrer-Policy` through a `no-referrer` meta tag before media loads. The source CDN rejected browser media requests carrying a localhost referrer; the policy also avoids exposing app navigation URLs to external media hosts. Browser verification checks actual playback rather than relying only on successful HEAD or metadata requests.

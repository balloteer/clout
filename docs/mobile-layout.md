# Seeker browser layout

The primary preview is **400 × 890 CSS pixels at DPR 3**, proportional to Seeker's published **1200 × 2670 (40:89)** display. This is a browser test profile, not a claim about the handset's default logical density. Source: [Solana Mobile specifications](https://solanamobile.com/seeker).

The October 13 layout follows the interaction structure visible in [TikTok's publisher screenshots](https://apps.apple.com/us/app/tiktok-videos-shop-live/id835599320): a compact top row, a vertical feed, actions on the right and five bottom tabs. [TikTok's safe-zone guidance](https://ads.tiktok.com/business/library/Creative_Codes_One_Pager.pdf) informed the separation between captions, actions and navigation. [Its content-sharing guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines/) informed the preview, editable caption and explicit publish action. These are layout references; Clout keeps its supplied branding and Seeker proportions.

- Feed frames stay at 40:89. Bundled portrait videos fill the frame; curated source videos retain their original aspect ratio inside it. The action rail is outside the paged video rows, so the 48 × 48 eye button remains above Like while videos scroll. It opens the [Video investments sheet](investments.md), with current market SKR and recorded backing above buy/sell controls. There is no bottom investment banner.
- Browser paging uses real page-sized CSS snap targets. A wheel/trackpad gesture advances one post; touch uses mandatory snapping with a stop on every page. Playback and captions change after the page settles. Native paging retains its FlatList implementation.
- Sound starts enabled. If browser autoplay policy rejects audible playback, the video shows **Tap to play with sound** and starts from the user's tap. This is distinct from media failure and its Retry action. The top sound button still mutes and unmutes; dialogs and backgrounding pause playback.
- Create fits its available viewport. The caption can scroll internally, while video selection and the publish action remain visible. Compact heights reduce the preview and optional copy.
- Discover keeps search and categories pinned. Only its result list scrolls.
- The app shell follows browser viewport resizing, including switching from desktop to mobile without a reload. The mobile header is 52 CSS pixels and navigation is 60, with native safe-area handling retained.

## Verification

Run against the local browser preview on port 8081:

```sh
node scripts/review-mobile-viewport.mjs
node scripts/review-post-pager.mjs
node scripts/verify-web.mjs
node scripts/review-buttons.mjs
```

The viewport review checks ancestor clipping and center hit-testing before any click can auto-scroll an element into view. Its primary profile is 400 × 890 / DPR 3; secondary profiles are 390 × 844, 360 × 640 and 320 × 568, plus a desktop-to-Seeker resize. Evidence is written under ignored `artifacts/viewport-review/`. Additional Create and Discover checks cover long captions and enlarged browser text.

These layout checks use the desktop browser's mobile preview, as requested. Native APK versions and device verification are recorded separately in [android.md](android.md).

## Profile balance and market discovery

Profile places the live mock SKR balance directly above Saved finds, Following and Posts. It refreshes when Profile opens and when the app returns to the foreground; the card exposes a manual refresh and distinguishes loading and errors from a zero balance. The authenticated HTTP fixture at 400×890 verified the card inside the initial viewport, 1,000→990.5 refresh, error recovery and refresh after leaving and returning.

Feed includes a Markets filter and only renders the eye action for posts with an actual market reference. At 400×890 and 320×568, all three feed tabs fit and the pager retained one active video player. Curated videos retain their original source attribution and contain fit after live API hydration. These browser checks do not substitute for a physical wallet trade.

## Investment sheet

The current market balance, graph, amount entry, presets and quote action fit in the initial 400×890 Seeker sheet. At 320×568 the sheet scrolls internally while its title and close button remain fixed. Exact signed amount labels and a neutral empty graph distinguish a new zero-reserve market from missing data or an empty Clout trade log with a nonzero reserve. No trend, percentage gain, or trader marker is fabricated.

HTTP fixture checks cover zero, traded, negative net flow, unrecorded activity, migration, unavailable data and failed refreshes. On the primary viewport the graph occupies y371–479 and the quote action y714–764. The input currency stays within the sheet. Evidence is under `artifacts/investment-review/` and `artifacts/review-investments/`; these are layout and state fixtures, separate from live market verification.

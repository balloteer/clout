# Seeker browser layout

The primary preview is **400 × 890 CSS pixels at DPR 3**, proportional to Seeker's published **1200 × 2670 (40:89)** display. This is a browser test profile, not a claim about the handset's default logical density. Source: [Solana Mobile specifications](https://solanamobile.com/seeker).

The October 13 layout follows the interaction structure visible in [TikTok's publisher screenshots](https://apps.apple.com/us/app/tiktok-videos-shop-live/id835599320): a compact top row, a vertical feed, actions on the right and five bottom tabs. [TikTok's safe-zone guidance](https://ads.tiktok.com/business/library/Creative_Codes_One_Pager.pdf) informed the separation between captions, actions and navigation. [Its content-sharing guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines/) informed the preview, editable caption and explicit publish action. These are layout references; Clout keeps its supplied branding and Seeker proportions.

- Feed frames stay at 40:89. Bundled portrait videos fill the frame; curated source videos retain their original aspect ratio inside it. The action rail is outside the paged video rows, so the 48 × 48 eye button remains above Like while videos scroll. It opens the same mock-SKR market sheet. There is no bottom investment banner.
- Browser paging uses real page-sized CSS snap targets. A wheel/trackpad gesture advances one post; touch uses mandatory snapping with a stop on every page. Playback and captions change after the page settles. Native paging retains its FlatList implementation.
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

These changes were reviewed in the desktop browser's mobile preview, as requested. Earlier native APK evidence in [android.md](android.md) predates this layout revision; a rebuilt APK and physical Seeker review are separate acceptance steps.

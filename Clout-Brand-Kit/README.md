# Clout brand kit

These are the exact Flat header logos (F1–F5) and the minimal app icons. The wordmark is "clout" in Titan One with the googly eye as the "o". All lettering in the SVGs is converted to outlines, so the logo looks identical everywhere without installing the font. PNGs are exported from the same SVGs. Full rules are in `Clout-Brand-Guide.pdf`.

**Slogan:** Seek the best content, win SKR

Use this exact capitalization and wording wherever the slogan appears. The brand guide's headline and closing line use the updated slogan. SKR is the app currency; devnet test assets must be labeled test SKR. Seeker verification establishes device-token eligibility, not proof that every account represents a unique human.

## Folders

`1-wordmark` has the four wordmarks, transparent (`clout-wordmark-<name>.svg`) and on their background (`-on-bg`):

| File name | Board | Letters | Effects | Use on |
|-----------|-------|---------|---------|--------|
| lime  | F1 | pink  | ink outline + ink drop | lime, cream, white |
| pink  | F2 | white | ink outline + ink drop | pink |
| night | F3 | cream | pink drop, no outline  | ink / dark mode |
| mono  | F4 | ink   | none                   | white, docs, 1-color print |

`2-logo-boards` has the F1–F5 boards exactly as designed (wordmark + pill, and the F5 header lockups), at 640 and 1920 px.

`3-header-pill` has the compact two-eyes pill in each colorway: lime text on ink (F1), white on ink (F2 and F4), ink on pink (F3).

`4-lockups` has icon + wordmark side by side: light (pink tile, pink wordmark, cream background) and dark (lime tile, cream wordmark, ink background), with and without background.

`5-app-icon` has the minimal icons (pink is primary; lime, black, cream and two-eyes are alternates). `clout-icon-<name>` is rounded at 23%; `-square` is full-bleed for app stores and Android adaptive icons. Sizes 32–1024 px.

`6-favicon` has `favicon.ico`, `favicon.svg`, `apple-touch-icon.png`, and 16/32/48/192/512 PNGs.

`7-eye` has the googly eye alone for loaders, reactions and stickers.

`8-fonts` has Titan One (display) and DM Sans (body, variable) with their SIL Open Font Licenses, which allow use and redistribution in apps.

`9-tokens` has `tokens.json`, `clout.css` (CSS variables + sticker button), `tailwind.clout.js` and `clout.theme.ts` (React Native / Expo).

## Quick rules

The eye always looks up and to the right; never mirror or recolor it. Keep clear space equal to the eye's height. Minimum sizes: wordmark 80 px wide, icon 24 px, pill 32 px tall. The app icon stays minimal: no outline, badge or shadow. Small text on pink or lime is always ink.

## Web snippet

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#FF3D8B">
```

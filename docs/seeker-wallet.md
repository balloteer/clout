# Seeker wallet login

Clout's native Android and Android-browser wallet paths target `https://connect.solanamobile.com` on every authorization and signing request. There is no generic wallet chooser, extension-wallet discovery, or fallback to `solana-wallet:`. Solana Mobile publishes this certified-wallet App Link in its [Seeker Connect example configuration](https://github.com/solana-mobile/seeker-connect/blob/main/js/examples/example-web/src/config.ts); the domain publishes [Android Digital Asset Links](https://connect.solanamobile.com/.well-known/assetlinks.json).

The native app uses Mobile Wallet Adapter's `transact(callback, { baseUri })` through the kit adapter. The browser uses the official Seeker Connect SDK, pins both `firstConnectWalletBaseUri` and every interaction's `walletUriBase`, and fixes its chain to `solana:devnet`. Returned authorization endpoints must match the pinned HTTPS origin and root path without credentials, query, or fragment. Missing or unexpected endpoints are rejected before message or transaction signing. Reauthorization cannot silently switch accounts.

Desktop browsers show an explanation and a disabled connection button. Android detection is a convenience check, not a security proof: modern Chrome can hide the phone model, and user-agent values can be spoofed. Successful association still requires the certified-wallet App Link to open the installed wallet.

The cache is isolated under `clout-seeker-wallet-v1`, stored in SecureStore on native and sessionStorage in the browser. Earlier generic-wallet authorization/session caches are never restored. Native additionally removes the previous `clout-session` entry. Wallet signatures authenticate a single-use server challenge; every transaction still requires wallet approval, with its signature persisted before RPC submission.

## Limits

Endpoint pinning controls the supported app login path. A signed Solana message proves control of an address; it does not cryptographically attest the wallet application's identity or a Seeker device to the API. An authorization response's `wallet_uri_base` is not a server-verifiable attestation. The shared certified-wallet domain also delegates to test/staging and other official packages. These checks must not be described as physical-device authentication, nor as preventing a separately written API client from signing a valid challenge. A stronger server restriction requires a trusted device/wallet attestation mechanism. This change does not enable mainnet SGT or `.skr` queries, and does not label a wallet as Seeker-verified merely because it used this connection route.

Browser Seeker Connect uses Solana Mobile's `relay.solanamobile.com`. The developer must accept [Solana Mobile's relay terms on the quickstart page](https://docs.solanamobile.com/solana-mobile-stack/seeker-connect-quickstart) before using that relay. The SDK's [official repository](https://github.com/solana-mobile/seeker-connect) describes its transport and supported platforms.

## Verification

- `npm run test --workspace @clout/mobile` executes endpoint/lookalike rejection, unchanged challenge validation, and the actual native/web transport functions with deterministic wallet transports. It verifies pinned launch options and devnet, rejects Fakewallet responses before signing, and refuses untrusted cached endpoint values before opening any session.
- Desktop browser checks verify that connect is disabled and that a forged locally cached authorization does not restore a desktop login. Android-browser UI can be checked without launching a wallet.
- Successful authorization, returned production-wallet endpoint shape, and transaction signing still require a real Seeker. Previous Fakewallet emulator login evidence no longer validates the current restricted path. No new APK has been built for this change.

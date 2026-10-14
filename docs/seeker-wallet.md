# Seeker wallet login

The Android APK uses the official Mobile Wallet Adapter protocol with explicit routing to the installed production Seed Vault Wallet. The Expo `withSeekerWallet` plugin adds a native routing guard: it checks the package and signing certificate against Solana Mobile's published [Android Digital Asset Links](https://connect.solanamobile.com/.well-known/assetlinks.json), resolves an enabled/exported local-association activity, and launches that exact component. Only `com.solanamobile.wallet` and `com.solanamobile.seekerwallet` are eligible. Test, staging, store and generic wallet packages are excluded. The app requests `solana:devnet` throughout.

The native bridge must be present before JavaScript can start a wallet session. This prevents an older APK loading new JavaScript from falling back to a generic chooser. The native transport does not use an authorization response's optional `wallet_uri_base` to choose the app: the signed package is verified before association. This avoids rejecting valid wallets that omit that optional field or return a different endpoint prefix, both allowed by the [MWA specification](https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec.html).

Before opening the wallet, native login checks that the configured API is reachable and identifies itself as Clout in connected devnet mode. Authorize, server challenge retrieval and message signing share one wallet association. The server verifies the single-use challenge before the app saves a login session. An explicitly rejected cached authorization gets one fresh authorization attempt; other errors and signing/submission failures are never retried by that recovery path. Reauthorization cannot silently switch the account.

The Android-browser path remains on the official Seeker Connect SDK and certified-wallet App Link `https://connect.solanamobile.com`. Browser endpoint checks remain separate from the native package checks. Desktop browsers keep connection disabled. Browser detection is a UI convenience, not proof of device ownership.

Native and browser session caches use policy version 2, invalidating older routing authorizations. Wallet signatures authenticate the server challenge; every transaction still requires wallet approval and its signature is persisted before RPC submission. Explicit wallet cancellations remain quiet. Connection failures show a retry explanation, including USB/server requirements for the loopback preview.

## USB preview

The local APK embeds `http://127.0.0.1:8787`. Keep the Mac API running and the phone connected, then forward that port:

```bash
bash scripts/android-env.sh adb -s YOUR_SEEKER_SERIAL reverse tcp:8787 tcp:8787
```

Disconnecting USB prevents API-backed login, trading and faucet requests. A portable connected APK requires an HTTPS-hosted API and a rebuild. Neither successful wallet association nor a healthy API on the Mac proves phone-to-API reachability.

## Limits

Local package/signature verification restricts the native app's supported wallet route. A signed Solana message proves address ownership to the API; it does not provide server-verifiable device or wallet-application attestation. A separately written API client can still authenticate its own valid signature. The API can resolve the authenticated address to a display-only `.skr` name over a read-only mainnet connection. This lookup does not verify a Seeker device, change the authenticated wallet, or authorize a transaction. Mainnet SGT checks remain disabled.

Browser Seeker Connect uses `relay.solanamobile.com`; the developer must accept [the relay terms](https://docs.solanamobile.com/solana-mobile-stack/seeker-connect-quickstart) before using it. The native APK does not use that relay.

## Verification

Transport and policy regressions cover devnet selection, optional native endpoint metadata, unchanged signed challenges, expired-token recovery, account changes, stale APK rejection and one-association login. Native plugin checks cover deterministic generation, package/certificate restrictions and preserving unrelated intents. Emulator checks can establish that generic wallets are rejected; the owner subsequently confirmed a complete physical Seeker login and a 1,000 mock SKR faucet mint on version 0.1.2. Trading still requires a separate wallet approval. See [Android build evidence](android.md) for the current artifact and what has actually been exercised on hardware.

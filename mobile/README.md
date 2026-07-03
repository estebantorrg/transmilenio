# TransMilenio Explorer — Android app

Native Android shell (Capacitor 6) around the same web client the website ships. One codebase, two targets: the site serves `client/` from the server; this app bundles the identical build inside an APK.

## Why a native app changes live tracking

The live-bus API is CO-IP geofenced **and** serves no CORS (spec §5.2.1). On the website that forces relays/proxies/extensions. Inside the APK, requests go through Capacitor's native HTTP layer (`client/src/services/nativeLive.ts`):

- **No CORS** — native HTTP is not a browser fetch, so the missing `Access-Control-Allow-Origin` is irrelevant.
- **User's own IP** — requests leave from the phone. On any Colombian connection (cellular or wifi) the geofence passes with **no relay, proxy, or extension involved**.

Live cascade in the app: **native direct → Live Bridge → CO relay → server** (the web tiers remain as fallback, e.g. for a user outside Colombia). All other `/api/*` calls (catalog, ArcGIS, card balance, geocode) also use native HTTP against the hosted server (`https://transmilenio.onrender.com/api` by default), which bypasses webview CORS — the server needs no allow-list entry for the app.

The service worker is not registered in the app (assets already live in the APK; see `client/src/main.ts`).

## Prerequisites

- Node 18+, JDK 17
- Android SDK with `platform-tools`, `platforms;android-34`, `build-tools;34.0.0`
  (`android/local.properties` → `sdk.dir` must point at it)

## Build

```bash
npm install
npm run apk        # builds web → syncs → gradle assembleDebug
```

APK output: `android/app/build/outputs/apk/debug/app-debug.apk`.

Individual steps: `npm run build:web` (client build into `www/`, API base overridable via `TM_MOBILE_API_BASE`), `npm run sync` (copy into the Android project), `npm run open` (Android Studio).

## Release builds

`assembleDebug` produces a debug-signed APK, installable directly (enable "install unknown apps"). For Play Store / general distribution, create a keystore and configure `signingConfigs` in `android/app/build.gradle`, then `gradlew assembleRelease`.

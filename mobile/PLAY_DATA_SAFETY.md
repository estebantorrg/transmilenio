# Google Play — Data safety answers (APK)

Answers for **Play Console → App content → Data safety** for the Android app
(`mobile/`, UI in `client/mobile/`). They describe the **APK only**: the website
has its own flows (our server, Cloudflare Analytics, GeoJS) that do not apply
here. Every answer below matches the privacy policy, `shared/legal.js`
(<https://transmilenio.onrender.com/privacidad/>); a change to an APK data flow
changes the policy and this file in the same commit.

Play's definitions, which the answers follow:

- **Collected** = sent off the device by the app, to us *or to anyone else*
  (here it is never us: the APK does not talk to our server).
- **Shared** = sent to a third party, *except* a transfer the user starts and
  would reasonably expect (looking up a balance, asking for a walking route,
  searching an address). Those are collected but not shared.
- Data that only lives on the phone (saved cards, favourites, recent trips, NFC
  reads) is **not collected**.

Checked in the build, October 2026: permissions `INTERNET`,
`ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`, `RECORD_AUDIO`, `NFC` (merged
from phonegap-nfc), no background location; no analytics, crash or ads SDK in
the Gradle build; every host is HTTPS (TRANSMILENIO's app host and
`gis.transmilenio.gov.co`, `routing.openstreetmap.de`, `photon.komoot.io`,
`basemaps.cartocdn.com`); the catalog ships inside the APK.

## Overview

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all of the user data collected by your app encrypted in transit? | **Yes** — HTTPS only |
| Do you provide a way for users to request that their data is deleted? | **Yes** — by email (policy §8); no accounts, so no deletion URL is required |
| Does the app let users create an account? | **No** |

## Data types

### Location → Precise location *and* Approximate location
- **Collected:** Yes. The start and end of each walking leg of a planned trip
  (which can be the user's position) go from the phone to FOSSGIS
  (`routing.openstreetmap.de`) to draw the walk. Nearby stops, guidance and
  voice answers use the position on the device only.
- **Shared:** No — user-initiated (the user asked for that trip).
- **Processed ephemerally:** No. *We* never receive it, but the routing service
  may log requests, so "ephemeral" is not ours to promise.
- **Required or optional:** Optional (location permission can be refused; the
  planner then needs a typed origin).
- **Purpose:** App functionality.

### Financial info → Other financial info
- **Collected:** Yes. The tu llave card number the user types, sent from the
  phone to TRANSMILENIO's server to get the balance.
- **Shared:** No — user-initiated (pressing "Consultar" after the notice under
  the field).
- **Processed ephemerally:** No (TRANSMILENIO's server, not ours).
- **Required or optional:** Optional.
- **Purpose:** App functionality.
- Not collected: the NFC read (stays on the phone) and the last five card
  numbers the app remembers (stored on the phone).

### App activity → In-app search history
- **Collected:** Yes. Origin/destination text typed in the planner, sent from the
  phone to Photon (Komoot, `photon.komoot.io`) to find the place.
- **Shared:** No — user-initiated.
- **Processed ephemerally:** No (third-party service).
- **Required or optional:** Optional.
- **Purpose:** App functionality.

### App activity → App interactions
- **Collected:** Yes. Which route or stop the user is viewing is sent to
  TRANSMILENIO's server to get live buses and arrivals, together with the
  install ID below.
- **Shared:** Yes — declared as shared (conservative). TRANSMILENIO is a third
  party, and the request carries an identifier the user would not expect.
- **Processed ephemerally:** No.
- **Required or optional:** Optional (live features are optional).
- **Purpose:** App functionality.

### Device or other IDs
- **Collected:** Yes. A random install ID (`client/src/services/installId.ts`),
  created at install and derived from nothing on the phone. The APK sends it to
  TRANSMILENIO's server with live and balance requests, because that server
  answers `403` without one.
- **Shared:** Yes — sent to a third party, and not something the user starts or
  would expect.
- **Processed ephemerally:** No.
- **Required or optional:** Required (the user cannot turn it off; it is only
  sent when live or balance features are used).
- **Purpose:** App functionality.

## Not collected

| Category | Why |
|---|---|
| Personal info (name, email, phone, address, IDs) | Never asked for; no accounts. |
| Audio | The app uses Android's own speech recognizer and receives only the recognized text, which never leaves the phone. Audio handling is the OS service's, under the user's agreement with its provider (policy §2.6). *If Google reviewers treat the platform recognizer as part of the app, declare Audio → Voice or sound recordings: collected, not shared, optional, app functionality.* |
| Photos, videos, files, contacts, calendar, messages, health, web browsing | Not accessed. |
| App info and performance (crash logs, diagnostics) | No crash or analytics SDK. |
| Ads / marketing | No ads, no ad ID. |

## Notes for the rest of App content

- **Privacy policy URL:** `https://transmilenio.onrender.com/privacidad/` (public,
  not geofenced, HTML). It is `noindex` for search engines; Play only needs it
  publicly reachable, not indexed.
- **Ads:** No ads.
- **Target audience:** do not include under-13 age groups. That would bring the
  Families policy, and the terms ask minors to use the service with a guardian's
  consent. 13+ (or 18+) fits.
- **Location permission declaration:** foreground only, for nearby stops,
  trip planning and guidance.
- **Two points to revisit if the app changes:** a crash/analytics SDK, or any
  request routed through our server, would add rows above.

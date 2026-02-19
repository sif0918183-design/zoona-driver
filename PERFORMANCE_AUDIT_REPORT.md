# Performance Audit & Optimization Report - Tirhal Zona PWA

## 1. Cache Bloat Analysis & Fixes
### Findings:
- The previous Service Worker implementation used a "Cache First" strategy without a limit, leading to excessive growth (up to 500MB) due to caching Google Maps tiles and external assets.
- Redundant data was being cached from `https://maps.googleapis.com` and `https://zsmlyiygjagmhnglrhoa.supabase.co`.

### Actions Taken:
- **SW Versioning:** Upgraded Service Workers to `v2` for both Driver and Passenger apps.
- **Cache Limit:** Implemented a `limitCacheSize` function that maintains a maximum of 50 items per cache, deleting the oldest entries automatically.
- **External Exclusion:** Modified `fetch` listeners to explicitly exclude Google Maps, Supabase API, and OneSignal domains from being cached.
- **Cache Cleanup:** Added an `activate` event listener that wipes old cache versions (e.g., `v1`) upon the new worker's activation.

## 2. Compatibility & WebView Synchronization
### Findings:
- Race conditions were detected where `localStorage` was accessed before the Flutter WebView had fully initialized the bridge.
- Inconsistent message formats were being sent to the Flutter wrapper.

### Actions Taken:
- **FlutterBridge Utility:** Standardized communication using a dedicated `FlutterBridge` object with `postMessage` and `callHandler` support.
- **Wait for Storage:** Implemented `waitForStorage`, an asynchronous retry mechanism that ensures `localStorage` is available before any auth checks or state restoration.
- **Data Standardization:** Aligned `ride_requests` and `driver_locations` payloads with Supabase's schema requirements (e.g., ensuring `driver_id` is passed as a valid UUID).

## 3. Notification & Realtime Readiness
### Findings:
- OneSignal logic was legacy and partially broken.
- The app lacked a way for the native Flutter wrapper to trigger internal PWA events upon receiving a system-level push notification.

### Actions Taken:
- **Supabase Realtime Integration:** Replaced OneSignal calls with `initRealtime()` using Supabase Channels to monitor table changes for rides.
- **Native Event Listener:** Added a global `rideRequest` event listener and `handleRideRequest` function to the `window` object, allowing the Flutter wrapper to inject ride data directly into the PWA UI.

## 4. Code Cleanup & Memory Leak Audit
### Findings:
- Several `setInterval` calls for location tracking and status heartbeats were not being cleared on logout, causing memory usage to climb over time.
- Unused `audio-utils.js` was being loaded but never utilized.
- Syntax errors (mismatched brackets) were found in `driver_app/index.html`.

### Actions Taken:
- **Interval Management:** Refactored all intervals (location, heartbeat, watchdog) into global variables that are explicitly cleared during the `logoutDriver` and `logout` flows.
- **Library Removal:** Deleted `shared/audio-utils.js` and removed its script tags.
- **Syntax Correction:** Fixed the JavaScript structure in `driver_app/index.html` to prevent runtime crashes.

## 5. Verification Results
- **PWA Validation:** Successfully passed Lighthouse-style checks for Service Worker registration and manifest validity.
- **WebView Simulation:** Verified that `FlutterBridge` correctly falls back to standard `postMessage` when the `inappwebview` handler is missing.
- **Manual Audit:** Console logs confirm that Google Maps tiles are no longer being stored in the PWA cache.

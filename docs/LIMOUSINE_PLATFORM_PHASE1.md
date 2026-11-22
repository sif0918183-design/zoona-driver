# Limousine Tracka — Phase 1 database foundation

This branch introduces an isolated limousine schema only. It does not modify travel, immediate rides, driver wallet purchase flows, existing commission RPCs, chats, notifications, admin permissions, or Android projects.

## Locked business rules
- Daily rental contract, distinct from point-to-point rides.
- Start time is 07:00 Sudan local time; working day ends 17:00 (10 hours).
- Before 12:00, a partial first day is prorated by elapsed rental hours / 10; at/after 12:00 the day's commission is a full day.
- Commission hold starts at T-20h. If selected after T-20h, attempt immediately.
- Funding grace is min(4 hours, remaining time to start).
- Funding expiry removes only that driver's selected status, preserves other acceptances, and returns request to awaiting_driver_selection.
- Snapshot daily price and commission rate on the contract.
- Scheduled end closes automatically; early termination requires counterpart confirmation and admin resolution.
- Settlement charges executed-day commission only, releases unused held funds, and admin penalty cannot exceed remaining days' commission.
- Ledger is append-only; reversals are new rows.

## Migration
`supabase/migrations/202611220001_limo_phase1.sql`

The migration is intentionally not applied to Supabase. Backend APIs, cron processing, client UIs, admin UI, and Android WebView navigation are later phases.

## Important deployment boundary
The two supplied Android repository names currently resolve to repositories whose default-branch trees are Flutter InAppWebView example collections (e.g. `back_forward_navigation_gestures`, `custom_error_page`, `multi_webview_tab_manager`) and do not expose the Tracka app source at their roots. Do not modify these repositories until the correct app source or actual build repositories are identified.

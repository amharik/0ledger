# Cross-browser evaluation

The current target is **Chromium Manifest V3**. This is an evaluation, not a support claim.

| Area | Chrome/Edge | Firefox | Safari |
| --- | --- | --- | --- |
| MV3 background | Service worker | Event page / service worker depending on version | Limited MV3 support |
| Side panel | `chrome.sidePanel` | No direct equivalent | No direct equivalent |
| IndexedDB/OPFS | Supported | IndexedDB supported; OPFS support varies | IndexedDB supported; OPFS constraints |
| `chrome.storage.local` | Supported | `browser.storage` via WebExtensions | Requires Safari Web Extension wrapper |
| `chrome.identity.launchWebAuthFlow` | Supported | Different identity API | Requires native app / ASWebAuthenticationSession |
| Google OAuth redirect | `chromiumapp.org` | Add-on redirect URL | Custom scheme / native flow |
| Downloads / file inputs | Supported | Supported | Supported with wrapper |

## Findings

- **Firefox** is the closest port. The main blockers are the side panel (needs a sidebar_action or
  popup fallback) and OAuth redirect plumbing. Core Dexie/parsing/reporting code is portable.
- **Safari** needs a Safari Web Extension wrapper plus an OAuth strategy outside
  `launchWebAuthFlow`. The side panel also needs a replacement UI surface.
- WXT can emit multiple targets, but the UI and auth layers need explicit fallbacks before claiming
  support.

## Decision

Ship Chromium first. Revisit Firefox after the hardening milestone; do not add browser-specific
shims that are not tested in a real browser. Any port must keep the same local-first data model and
must not add a backend.

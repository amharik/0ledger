# Cross-browser & Platform Evolution

## Architectural Transition: Browser Extension → Native Desktop App (Tauri)

The initial prototype targeted Chromium Manifest V3. However, based on practical accounting and workflow constraints in the Indian SMB market, **the browser extension path is deprecated**, and 0ledger is now maintained exclusively as a native desktop application using **Tauri v2** across Linux, Windows, and macOS.

### Why the Desktop Path Replaced MV3

| Constraint | Chromium MV3 Extension | Tauri Desktop Application |
|---|---|---|
| **Tally Prime Integration** | Blocked by Chrome CORS & CSP rules connecting to `localhost:9000` | Native OS socket/HTTP calls directly to `http://localhost:9000` |
| **Execution Lifecycle** | MV3 service workers terminate aggressively after 30s idle | Uninterrupted background processing for bank statement parsing |
| **Storage & Quotas** | Browser IndexedDB eviction risks under disk pressure | Persistent OS storage + local file dropzones without quotas |
| **Platform Consistency** | Different APIs between Chrome, Firefox, Safari | Single unified webview codebase (WebKitGTK on Linux, WebView2 on Windows) |
| **Privacy & Security** | Bound to browser permission prompts & store review cycles | Self-contained, privacy-preserving desktop application |

### Conclusion
Active feature development, packaging, and commercialization focus entirely on the Tauri desktop path. Legacy WXT browser extension scripts remain available under `npm run build:mv3:deprecated` for backward reference only.

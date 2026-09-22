# Mobile Changelog

## [0.1.2]

- Persisted one-time pairing across Wi-Fi and hotspot address changes by rediscovering the saved host ID on its saved gateway port.
- Recovered active event streams through the same host rediscovery flow without requiring another QR scan.
- Added background indexing states for very large mutation-only chats while keeping VS Code responsive.
- Added constant-memory Earlier/Newer paging for progressively indexed large conversations.

## [0.1.1]

- Fixed release APK connections to local HTTP gateways by applying Android cleartext traffic permission during every native prebuild.

## [0.1.0]

- Initial Android and iOS companion application for Copilot Monitor.
- Added QR/manual pairing, verified LAN endpoint recovery, and saved-host management.
- Added multi-window chat navigation, live SSE transcripts, model/effort/context controls, and approval modes.
- Added pending tool decisions, new chats, and historical request editing with branch replacement.
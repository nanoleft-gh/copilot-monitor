# Mobile Changelog

## [0.1.3]

- Consumed the gateway's `eventsV2` delta stream: one snapshot on connect, then compact patches, so streaming responses only transfer their new text and the XHR response buffer grows far more slowly. Older gateways that still send full `state` frames keep working.
- Reconnected for a fresh snapshot whenever a patch cannot be applied instead of showing stale data.
- Fixed the conversation list hiding every chat except the selected one: the computer only sends turns for the chat it is tailing, so visibility now follows the `isEmpty` flag from VS Code's index and unknown counts show the last-activity time instead of being treated as empty.
- Kept a model picked on the phone displayed until the computer confirms it, and showed the new model's own effort/context options (and VS Code's remembered values for it) while the change is pending, instead of the old model's values.
- Aligned all packages with Expo SDK 57 (`expo install --fix`); the previous `react-native-worklets` / `reanimated` versions crashed Expo Go on launch.

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
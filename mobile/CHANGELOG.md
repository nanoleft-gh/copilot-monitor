# Mobile Changelog

## [0.2.3]

- Markdown rendering now uses `react-native-markdown-display` (markdown-it), the renderer most widely deployed on Expo Go; `react-native-marked` threw at render time on the device. The dependency had also been dropped from `package.json` by an editor save racing `pnpm add`, so fresh installs lacked it.
- Assistant text is wrapped in an error boundary: if the markdown renderer ever throws, the message falls back to plain text and the error is logged instead of taking the whole chat screen down.

## [0.2.2]

- Learns the computer's addresses from the live stream: every snapshot carries the gateway's current `endpoints`, and changes are persisted immediately, so a remote address added in VS Code (or a changed home IP) is known before it is ever needed.
- Sends `ngrok-skip-browser-warning` on every request so ngrok free-tier tunnels answer without the interstitial page.

## [0.2.1]

- Pairing codes may carry the computer's other addresses (`#e=...`). The code's own address is tried first; if it is silent, every alternate is probed in parallel and the first that answers is used, so one code pairs both at home and away. All addresses are stored for reconnection.

## [0.2.0]

- Assistant replies render as GitHub-flavoured markdown (headings, lists, code blocks, inline code, links, quotes, tables) via `react-native-marked`; each text block is memoised so a streaming reply re-parses only the block that changed.
- Pairing now carries the computer's secret (read from the QR/link fragment) and sends it as a bearer token on every request and on the event stream. Secrets live in the device keystore (`expo-secure-store`), never in the host list. Hosts paired before 1.3.0 show "Needs re-pairing" and prompt for one scan.
- Connection resilience: the phone stores every address the computer advertises (all LAN interfaces plus its remote URL). When the last-good address fails it probes LAN candidates in parallel, then remote ones, then scans the subnet, and remembers the winner. Reconnects back off exponentially with jitter, a socket that goes silent past the gateway's keepalive is dropped and reopened, and a network change or the app returning to the foreground retries immediately. Newly advertised addresses (e.g. a tunnel URL added later in VS Code) are learned on the next successful connection.
- The header shows "Reconnecting…" while the stream is down and a clear message when the computer stopped accepting this phone's pairing.

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
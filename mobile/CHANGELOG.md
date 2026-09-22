# Mobile Changelog

## [2.0.0]

Pair once, stay connected: pairing secret, self-healing connections, remote access, and markdown replies.

<p align="center">
  <img alt="Conversations list" src="https://raw.githubusercontent.com/nanoleft-gh/copilot-monitor/master/demo/mobile-2-conversations-list.jpeg" width="30%">
  <img alt="Open conversation with markdown" src="https://raw.githubusercontent.com/nanoleft-gh/copilot-monitor/master/demo/mobile-3-opened-conversation.jpeg" width="30%">
  <img alt="Thinking effort picker" src="https://raw.githubusercontent.com/nanoleft-gh/copilot-monitor/master/demo/mobile-4-thinking-effort-edit.jpeg" width="30%">
</p>

- **Pairing secret.** Pairing reads the computer's secret from the QR/link fragment and sends it as a bearer token on every request and on the event stream. Secrets live in the device keystore (`expo-secure-store`), never in the host list. Hosts paired before this release show *Needs re-pairing* and need one scan.
- **One code, every address.** A pairing code carries all of the computer's addresses (`#e=…`). The code's own address is tried first; if it is silent, every alternate is probed in parallel and the first that answers is used, so the same code pairs at home and away. All addresses are stored.
- **Learns addresses live.** Every gateway snapshot carries the current `endpoints`; changes are persisted immediately, so a remote address added later in VS Code, or a changed home IP, is known before it is ever needed. When the last-good address fails, LAN candidates are probed in parallel, then remote ones, then the subnet is scanned (Wi-Fi only).
- **Resilient stream.** Reconnects back off exponentially with jitter, a socket that goes silent past the gateway's keepalive is dropped and reopened, and a network change or the app returning to the foreground retries immediately. The header shows *Reconnecting…* while the stream is down and a clear message when the computer stopped accepting this phone's pairing.
- **Markdown replies.** Assistant messages render as GitHub-flavoured markdown (headings, lists, code blocks, inline code, links, quotes, tables) via `react-native-markdown-display`, memoised per block so streaming re-parses only the block that changed. A plain-text error boundary keeps the chat readable if the renderer ever fails.
- Sends `ngrok-skip-browser-warning` on every request so ngrok free-tier tunnels answer without the interstitial page.
- Native dependencies pinned to Expo SDK 57 (React Native 0.86.3, worklets 0.10.1, reanimated 4.5.1, screens 4.26.2); earlier mismatches crashed Expo Go on launch.

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
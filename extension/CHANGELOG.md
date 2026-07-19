# Changelog

## [1.1.0]

- Fixed a Stable VS Code race where a blank chat was created successfully but its asynchronously persisted identity appeared just after the New Chat request returned an error.
- Waits up to two seconds for the newest newly persisted session before reporting that VS Code did not expose the chat identity.
- Kept the exact active empty chat visible on mobile as Ready to chat while continuing to hide stale inactive empty sessions.
- Recovered new-chat identity from the newly persisted session when Stable creates the blank chat but does not expose its current resource through the internal panel command.
- Added revision-fenced editing and resubmission of historical user requests from mobile and web.
- Delegated branch truncation, historical model/context restoration, active-request cancellation, and file checkpoint undo to VS Code's native chat editor.
- Added destructive confirmation before replacing a request and every subsequent response.
- Exposed edit controls only for turns carrying real VS Code request identities; generated fallback IDs remain read-only.
- Added local, aggregate, gateway, and transcript regression coverage for historical request editing.
- Added debounced filesystem notifications for VS Code's native model and model-configuration SQLite state.
- Coalesced write bursts into one serialized two-key read and skipped parsing or SSE emission when raw values are unchanged.
- Reduced healthy idle polling to once per second while preserving the previous 250 ms fallback when filesystem watching is unavailable.
- Added automatic watcher recovery, database replacement handling, and one bounded fast retry for transient SQLite failures.
- Added deterministic coverage for debounce, no-overlap reads, coalescing, fallback polling, watcher recovery, and disposal.
- Fixed VS Code-originated model and configuration changes not reaching mobile until another action refreshed state.
- Allowed the existing 250 ms native-state synchronizer to run on Stable builds whose internal current-session command is executable but omitted from command discovery.
- Removed all developer model-inspection commands from model, configuration, approval, rename, and new-chat operations.
- Targeted mobile model changes at the exact active Copilot session before invoking VS Code model selection.
- Merged catalog and persisted configuration schemas by field key so effort and context controls remain available together.
- Kept persisted model, configuration, and approval state authoritative over stale live transcript exports.
- Reduced native model synchronization latency and returned control requests immediately after authoritative cache updates.
- Fixed mobile configuration writability, approval availability, and optimistic request reconciliation.
- Added regression coverage for partial model schemas and stale live control overlays.
- Fixed the Activity Bar QR, Open Dashboard, and Copy URL actions retaining a dead gateway port after lease failover.
- Revalidated follower addresses against the current healthy lease and refreshed the visible mobile sidebar every two seconds.
- Serialized gateway shutdown with in-flight lease heartbeats to prevent cleanup races.
- Added post-failover address-change regression coverage.
- Added companion-app stale endpoint recovery, actionable host/chat routes, and duplicate-safe transcript rendering.
- Fixed mobile QR codes advertising WSL, Hyper-V, Bluetooth, or other virtual adapters instead of the phone-reachable Wi-Fi or Ethernet address.
- Added physical-adapter prioritization coverage with a private virtual-adapter fallback.
- Completed LAN gateway QR/manual pairing in the companion app with gateway validation, durable multi-host storage, and paired-computer cards.
- Added a Copilot Monitor Activity Bar view with an offline-generated LAN dashboard QR code and Open/Copy controls.
- Added one persistent machine identity and shared window registry across VS Code Stable, Insiders, and profiles for the same OS user.
- Added atomic gateway election leases, heartbeat-based failover, and dynamic port fallback when the preferred port belongs to another application.
- Added product/channel metadata to shared window descriptors while retaining legacy descriptor compatibility.
- Added focused host identity, lease concurrency, cross-window aggregation, occupied-port, and failover coverage.

## [1.0.2]

- Added one-second lightweight reverse synchronization for native VS Code model and model-configuration changes using exact current-session identity and read-only application storage keys.
- Kept reverse synchronization independent of full transcript exports, DOM rendering, and workbench focus.
- Confined horizontal scrolling to code and terminal blocks so long commands and unbroken lines no longer create a chat-wide scrollbar.

## [1.0.1]

- Stopped expensive full chat exports while sessions are idle and reduced working-session export cadence from five to two times per second.
- Sent complete transcript bodies only for the selected chat while retaining accurate turn counts for inactive conversations.
- Added bounded 40-turn transcript windows with Load earlier/newer controls and bounded search/message-jump expansion.
- Capped long-chat message rails at 80 representative jump points.
- Suppressed empty fenced code blocks that appeared as blank rectangles.
- Stress-tested a 500-turn conversation at 40 rendered turns, 73 jumpers, roughly 603 DOM nodes, and zero empty code blocks.

## [1.0.0]

- First public Visual Studio Marketplace release under the Nanoleft publisher.
- Added a responsive multi-window GitHub Copilot Chat dashboard for desktop and mobile browsers.
- Added live transcripts, thinking, tools, terminal output, one-time approvals, model switching, model configuration, and per-chat approval modes.
- Added persistent conversation boards, pinning, rename, new-chat creation, search, navigation, Markdown export, dark mode, and Mermaid diagrams.
- Added exact window/session routing, shared-port leader failover, stale-gateway capability detection, and 39 automated tests.
- Added Marketplace metadata, public security documentation, Nanoleft repository links, and final blue infinity/cloud branding.

## [0.6.1]

- Restored the exact supplied blue infinity/cloud logo path in a clean browser-safe SVG and generated an uncropped padded PNG for VSIX metadata.
- Replaced native approval confirmation with an accessible branded modal and persistent Never show this warning again preference.
- Added gateway API capability reporting so stale gateway leaders produce a precise reload-all-windows message instead of unexplained 404 errors.
- Expanded the mobile approval selector to preserve its full label.

## [0.6.0]

- Changed dark mode to a pure-black canvas with neutral elevated surfaces.
- Normalized and integrated the Copilot Monitor infinity/cloud icon in the dashboard, extension metadata, and same-origin asset server.
- Added persistent collapsible conversation board columns with drag/drop, accessible move actions, custom columns, and per-chat pinning.
- Added exact-session web rename through validated persisted title mutation and native VS Code restore verification.
- Added exact-window new local chat creation with transient dashboard visibility before the first persisted turn.
- Added per-chat Default, Bypass Approvals, and Autopilot selection beside model controls with safety confirmation, persistence, and native verification.
- Added local, aggregate, and gateway tests for rename, new-chat, approval, transient empty sessions, and icon serving.

## [0.5.1]

- Fixed production CSP headers to allow the bundled same-origin Mermaid script.
- Replaced native model, effort, context, workspace, and conversation selects with accessible custom listboxes.
- Added controlled upward/downward dropdown placement, selected checks, keyboard navigation, click-outside dismissal, and viewport-safe menus.
- Fixed dark-mode dropdown backgrounds, option text, hover states, and selected-state contrast.

## [0.5.0]

- Added offline Mermaid 11.16 rendering for fenced `mermaid` blocks with strict security, accessible SVG output, errors that fall back to source, and light/dark diagram themes.
- Added a persistent dashboard light/dark theme toggle and a complete dark surface palette.
- Reworked mobile workspace and conversation selection into labeled compact navigation fields.
- Added complete conversation Markdown export through clipboard copy, downloadable `.md`, and a selected-text fallback dialog when browser clipboard access is blocked.
- Added same-origin Mermaid asset routes and HTTP coverage for both window and aggregate servers.

## [0.4.0]

- Redesigned the dashboard with a compact workspace/conversation navigator and quieter work-focused visual system.
- Moved model, effort, and context controls from the header into a Copilot-style composer toolbar.
- Added a right-side message rail with per-turn jumpers plus top and bottom navigation.
- Added in-conversation search with result counts, next/previous controls, highlighting, and keyboard access.
- Replaced whitespace-preserving transcript output with semantic markdown blocks and inline formatting.
- Made the live selected model's catalog schema authoritative so effort and context choices remain model-specific.
- Added dedicated tablet and phone layouts with collision and overflow validation.

## [0.3.3]

- Fixed the save-changes dialog that appeared on every effort or context change by discarding VS Code's inspect scratch editors with `revertAndCloseActiveEditor` instead of a plain close.

## [0.3.2]

- Added native in-memory chat-model inspection after configuration reload so changes are verified before success is returned.
- Preserved selected-model metadata when hot exports contain only the latest request model.

## [0.3.1]

- Added exact-session thinking-effort and context-size changes from the dashboard.
- Added deterministic chat release, persisted input-state mutation, profile-default mirroring, and native session restore.
- Added typed configuration routing through the local bridge, aggregate monitor, and shared gateway.
- Added configuration mutation, profile preservation, HTTP routing, and responsive writable-control tests.

## [0.3.0]

- Added per-window inventory for every selectable GitHub Copilot model, including Auto.
- Added selected and last-used model state plus exact thinking-effort and context-size schemas.
- Added exact window-and-session model switching through the local bridge and shared gateway.
- Added responsive model controls with read-only effort/context values where stable VS Code exposes no setter.
- Added model snapshot, configuration parser, cache isolation, and three-hop routing tests.

## [0.2.1]

- Added one stable LAN gateway that aggregates every open VS Code window.
- Added exact window-and-session prompt routing and chat activation.
- Added per-window heartbeat discovery, stale cleanup, and same-port leader failover.
- Removed URL tokens and authentication for trusted personal Wi-Fi use.
- Added live in-memory response streaming with isolated persisted/live session caches.
- Added responsive desktop and mobile window/chat selectors.
- Added live terminal output, command metadata, and exit status in tool activities.
- Added exact-routed one-time Allow/Skip controls for pending terminal confirmations.
- Added registry, aggregation, routing, failover, parser, cache, and HTTP/SSE tests.
# Changelog

## [2.1.0]

Opening the phone no longer makes every VS Code window re-read its chat logs. The list is metadata, history lives in an on-disk digest, and only the chat you are looking at is tailed.

### Why

With five windows open, connecting the app made each window parse its selected session log, transcript and debug log from byte 0 — about 750 MB across the machine, with extension hosts climbing to several GB and the desktop stalling. VS Code compacts a session log into a single JSON line after 1024 mutations, so "tailing" a compacted 120 MB log meant `JSON.parse` of 120 MB. Backgrounding the app tore everything down and the next foreground paid it all again.

### Metadata-first list

- The session list is built from VS Code's own index (`state.vscdb`), `fs.stat` and directory events only. No session log is parsed until a client opens a chat. Turn counts are shown only for opened chats.

### Watched chats

- A client names the chat it displays on its event stream (`GET /api/events?v=2&watch=<windowId>|<sessionResource>`); the watch lives exactly as long as the stream. The gateway unions every client's chats and forwards each window only its own (`POST /api/clients {count, watched}`), one window at a time, 100 ms apart. At most three chats per window are attached; a chat stays attached for 60 s after its last watcher leaves so a brief background/foreground does not redo the work.
- Clients that never send `watch` receive metadata only. New capability `lazyHistory` in `/api/health`; `apiVersion` stays 4. The browser dashboard and the 2.1.0 mobile app send `watch`; the 2.0.0 app shows chats as loading until updated.

### On-disk digest instead of in-memory projection

- Each opened chat gets a per-workspace SQLite digest (`history.db` in the extension's workspace storage; `node:sqlite`, no native module): one row per request with the normalised turn and a compacted raw request. Appends are consumed from the recorded byte offset; a compaction rewrite is detected through a hash of the bytes before that offset and rebuilt.
- Lines above 256 KB — a compacted Initial entry is the whole session on one line — are tokenised with `stream-json`, so one request exists in memory at a time and every string is capped at 64 KB. Rebuilds run in a worker thread; short appends are applied inline.
- Raw JSON is kept only for the newest 16 requests (VS Code never diffs a sealed request again); a mutation to an older one forces a rebuild.
- History pages are range selects; the phone's *Load earlier messages* never touches the log. Paging works for a chat that is no longer open as long as its digest still matches the file.
- Measured on a real 122 MB compacted log: first open 1.8 s in the worker, +19 MB peak heap, 11 MB digest, 20-turn page in 17 ms, reopen 0 ms.

### Live logs start at the end

- Copilot's transcript and debug log are scanned backwards (256 KB blocks, at most 4 MB) to the line that opens the second-last turn and tailed from there; a 90 MB debug log costs kilobytes to attach. `LineTailer` reads 1 MB chunks and yields between them. The live overlay keeps 8 turns instead of 200.

### Removed

- `SessionLogProjection`, the 40-turn in-memory window and the separate "oversized" path (paged mutation index in `globalStorage/progressive-history`) are gone; the digest covers every size up to 1 GB.

### Fixes

- **Working chats stay live.** Opening a chat while Copilot was working could freeze the phone on what it showed at that moment until the turn ended and the chat was reopened: the approval probe's export replaced the turn's text and tool list and kept doing so. The export now contributes only its verdict (which tools await confirmation, and the model state); live text and tools keep streaming. A watched chat whose digest is still being built shows its live turns instead of *Loading*.
- **No more false approval prompts.** Any tool still running after 2 s used to be offered for approval, so long terminal commands and searches that needed no confirmation showed *Allow*, and tapping it answered "no longer pending". Approval now appears only when VS Code's own tool state says the call is waiting (`isConfirmed` unset and no result in the renderer's export). Chats in auto-approve or autopilot mode are never probed.
- Digests of chats deleted in VS Code are removed when the digest opens.
- **Text and thinking stream within a model round.** Copilot writes a round's text to its logs only when the round ends, so the phone used to see a long answer appear all at once. While a watched chat is working, the monitor now exports VS Code's live chat on a CPU budget (at most 1/20 of the UI thread, never more often than every 1.5 s) and shows the newest request's text and thinking while they are ahead of the logs. Tool status still comes from the logs, and the preview can never hold back progress the logs already show. Chats whose export exceeds 4 MB (estimated from the session log before the first export) get round-level updates only, so VS Code's UI stays responsive.
- **Probes no longer steal focus.** Stall probes, the streaming poll and the refresh after an approval export whatever chat VS Code has focused and keep the result only if its request ids prove it is the watched chat; otherwise they back off (10 s, doubling to 60 s). Only a user action from the phone focuses the chat.
- **Stale *Allow* cleared.** Approving a tool directly in VS Code now removes the prompt from the phone on the next poll, instead of leaving an *Allow* that answered "no longer pending".
- **Approval probe works for long chats.** The export buffer grew from 16 MB to 96 MB and is no longer parsed whole: request ids are found by byte search and only the newest request is parsed.

## [2.0.1]

### Fixes

- Fixed a directory watcher race condition on Linux/inotify where fast recursive directory creation (`mkdir -p`) could cause an ancestor watcher re-attach to miss events and hang reconciliation.

## [2.0.0]

Pair once, reach your computer from anywhere. This release adds a pairing secret, one-click remote access over free tunnels, self-healing connections on the phone, and markdown on mobile.

![Remote access with a VS Code dev tunnel](https://raw.githubusercontent.com/nanoleft-gh/copilot-monitor/master/demo/extension-4-vs-tunnel-remote-access.png)

### Security: pairing secret

- Every `/api/*` route except `/api/health` now requires the computer's pairing secret (`Authorization: Bearer …`). The secret is minted once per computer in the shared state directory, shared by every VS Code window so gateway failover keeps it, and compared in constant time.
- The QR code and *Copy pairing link* carry it in the URL fragment (`#k=…`), which never reaches any server or log. The browser dashboard trades it for an `HttpOnly; SameSite=Strict` cookie via `POST /api/auth` and drops it from the address bar.
- `Copilot Monitor: Reset Pairing Secret` rotates it; other windows converge because the gateway re-reads the secret file when it sees a token it does not know.

### Remote access without a paid server

- **One click.** *Turn on remote access* in the sidebar forwards the gateway port through a Microsoft dev tunnel by running the `code-tunnel` CLI that ships inside VS Code, with the same stdin/stderr protocol the Ports view uses (`tunnel forward-internal`). No proposed API, no manual forwarding. If GitHub is not signed in, the sidebar offers the sign-in and continues on its own. The CLI persists its tunnel, so the `https://<id>-43121.<cluster>.devtunnels.ms/` address survives restarts and reboots.
- **ngrok** as an alternative service. Paste **either** an ngrok API key or an agent authtoken (they look alike; the extension tells them apart and mints a dedicated authtoken from an API key). The agent runs with `--url https://`, which binds the account's stable auto-assigned dev domain, so the address is permanent on the free plan too. A reserved domain can pin a chosen name. If the agent is not on PATH, the sidebar shows the install command for your OS.
- **Your own route** (Tailscale, Cloudflare Tunnel, reverse proxy) can be entered as a manual address.
- Remote access is a machine-wide choice stored next to the pairing secret — not a VS Code setting — owned by the window that runs the gateway and managed from any window through the authenticated `GET`/`POST /api/remote-access` routes. Leadership changes move the tunnel to the new owner.

![ngrok setup in the sidebar](https://raw.githubusercontent.com/nanoleft-gh/copilot-monitor/master/demo/extension-2-remote-access-ngrok.png)

### Connections that heal themselves

- `/api/health` advertises every address the gateway answers on (`endpoints`): all physical LAN interfaces plus the active tunnel and any manual URL. The same list is streamed in every state snapshot and pushed the moment a tunnel comes up or goes away, so a phone paired at home learns a remote address added later without re-scanning, and a phone on the tunnel learns a changed home IP.
- One pairing code for home and away: the QR carries every address (`#k=<secret>&e=<addresses>`); the app pairs through whichever answers and remembers all of them. A **Home Wi-Fi / Anywhere** picker chooses which address a phone camera opens first.
- Phones probe LAN candidates in parallel, then remote ones, then fall back to a subnet scan when the last-good address fails.

![One code for home and away](https://raw.githubusercontent.com/nanoleft-gh/copilot-monitor/master/demo/extension-3-vs-tunnel-dash.png)

### Fixes

- Chats no longer flash "Working" after being opened and left on the phone: replaying an existing transcript on attach, and log lines that touched no turn, were counted as activity.
- The dashboard's event stream backs off instead of reconnecting every 250 ms when it dies before its first snapshot.
- Removed the short-lived `githubCopilotMonitor.remoteAccess` / `remoteUrl` settings and the `Set Remote Access URL` command; the sidebar is the single place to manage remote access. Renamed *Copy Dashboard URL* to *Copy Pairing Link*.

### Wire protocol

- `apiVersion` stays 4; new capability `remoteAccess`. New routes: `POST /api/auth`, `GET`/`POST /api/remote-access`. `GET /api/health` adds `authRequired`, `authorized`, `endpoints`. `GatewayState` adds `endpoints`.

## [1.2.3]

- Fixed effort/context (and rename, approval-mode fallback) changes made from the dashboard or phone not reaching VS Code. These are written to the session log, which VS Code reads only when it loads a session; the previous "open in editor and close it" release did nothing while the chat panel still held the session. The session is now gathered into the panel, the panel is moved to a fresh blank chat so the last reference drops, VS Code's own dispose-time write is allowed to land, the change is appended, and the session is shown again from disk.
- Without the voice bridge, focusing a chat now lands it in the chat panel (open as editor, then "Move Chat into Side Bar") instead of leaving editor tabs behind; the panel is also what VS Code's own model-selection command acts on.

## [1.2.2]

- Fixed "VS Code created a chat but did not expose its session identity" when creating a chat from the dashboard or phone. The internal `_chat.voice.*` commands the monitor relied on exist only while `agents.voice.enabled` is on; VS Code offers no other way to ask for a new chat's identity, so the monitor now makes VS Code persist its live chats (a no-op rename of an existing chat runs the chat service's immediate save) and identifies the new chat from the session file that appears.
- Fixed the selected model snapping back to the previous one after changing it from the phone. The panel's stored selection is read from VS Code's storage, which flushes lazily, so a read right after the change still named the old model and overwrote the new one; a selection the monitor made now outranks such reads until storage confirms it. The same read no longer requires the voice bridge to know which chat is focused.
- Switching models now applies the effort/context VS Code remembers for that model, as VS Code itself does, instead of the model's schema defaults.

## [1.2.1]

- Read the model list from VS Code's own cached picker list (`chat.cachedLanguageModels.v2`) instead of Copilot's debug `models.json`, so newly rolled-out models appear in the dashboard and mobile app exactly when they appear in VS Code, with VS Code's own effort/context options. The debug-log file was only written with debug logging enabled and had gone stale.
- Fixed a stale model overlay: when VS Code was switched to a model the dashboard did not know, the previous selection stayed displayed and changing effort/context failed with "VS Code is still applying the selected model". The overlay is now recomputed from VS Code's storage on every change and dropped when it cannot be resolved.
- Model configuration changes no longer depend on the session log having caught up with VS Code's selection; the persisted value is reproduced from the catalog entry VS Code itself stores.
- Hid blank "New Chat" sessions VS Code leaves behind, except the chat that is selected, focused in VS Code, or was just created from a phone; the session list carries `isEmpty` so clients can tell an empty chat from one whose count is simply not loaded.
- The first viewer now opens on the chat VS Code has focused (falling back to the newest chat with content) instead of the most recently touched blank chat.
- Session lists no longer claim "0 turns" for chats that are not being tailed; they show the exact count when known, "Ready to chat" for empty chats, and the last-activity time otherwise.

## [1.2.0]

Event-driven core. The extension no longer polls, schedules exports, or re-reads whole chat logs; every piece of work is triggered by a file-system event, a connection event, or a user action. This fixes the machine-wide hangs caused by the previous 2-second live exports and full-file re-reads of large chats.

- Replaced the session watcher with `SessionCore`: non-recursive `fs.watch` on the exact `chatSessions`, `transcripts`, `debug-logs` and `state.vscdb` directories, with Windows-safe ancestor watching so a deleted-and-recreated directory is picked up again.
- Added `LineTailer`, which reads only new bytes from a remembered offset and verifies file identity (inode, size, anchor hash) so VS Code's in-place session log compaction, Copilot's debug log truncation, and rotations are detected and replayed instead of producing corrupt transcripts.
- Added `SessionLogProjection`, an incremental projection of VS Code's mutation log that keeps the newest 40 turns and compact summaries for the rest; verified byte-identical against a full replay on real 2 MB and 46 MB logs.
- Read the session list from VS Code's own SQLite session index instead of scanning and parsing every log file; locked reads are retried with backoff.
- Merged live transcript and debug log turns with persisted turns by user text and timestamp, never overriding sealed history; tools outstanding for two seconds become approvable and trigger a single stall-probe export.
- Removed the periodic live export entirely; exports now happen only on demand (`POST /api/sessions/sync`), for a stall probe, or after a model-state command.
- Made everything viewer-gated: with no dashboard or phone connected there are no watchers, no tailers, and no timers.
- Replaced 2-second window registry heartbeats with a publish-once descriptor that self-heals through `fs.watch`; the gateway discovers windows from registry events and treats its connection to each window as the liveness signal, purging descriptors of crashed windows after bounded reconnects.
- Removed the gateway lease heartbeat and the 2-second coordinator loop; leases are validated by the gateway's health nonce and followers hold an idle `GET /api/presence` stream whose closure triggers immediate re-election.
- Made the sidebar QR view re-render on address-change events instead of refreshing every 2 seconds, with an explicit Start state after the monitor is stopped.
- Ran SSE keepalive intervals only while a stream is open.
- Native model/effort/context synchronization no longer polls while its SQLite watcher is healthy.
- Bumped the gateway/bridge `apiVersion` to 4 and added the `sessionSync` capability; the `MonitorState` and `GatewayState` payloads are unchanged, so existing dashboards and mobile apps keep working.
- Added the `eventsV2` delta stream (`GET /api/events?v=2`): one snapshot, then compact JSON patches with string-append and keyed-array operations, so streaming responses send only their new text and a sliding turn window sends only the new turn. The dashboard, the mobile app, and the gateway’s relay to each window use it; protocol 1 remains available.
- Made the SSE hub keep its own copy of the last streamed state so patches stay correct even if a backend mutates state in place, and coalesced updates for slow sockets into one catch-up patch.
- Removed the progressive transcript, session state cache, and bounded file read modules that the new core made unnecessary.

## [1.1.3]

- Made machine-wide window registry heartbeats atomic and serialized so concurrent VS Code Insiders windows cannot expose empty or stale descriptors.
- Recovered a briefly missing lease from the healthy same-host gateway during rolling extension updates instead of replacing it on a random port.
- Clarified that each window's random loopback bridge is internal while all windows share one stable machine-wide pairing gateway.
- Refreshed the advertised LAN address for QR, open, and copy actions after Wi-Fi or hotspot changes without restarting VS Code.
- Replaced large-chat placeholders with progressive 40-turn history pages using compact transcript indexes or background mutation-log workers.
- Preserved real titles, prompts, assistant responses, completion state, and editable request IDs while discarding giant tool/result payloads from remote history.
- Cached compact mutation indexes by source fingerprint and bounded cache growth; first indexing stays off the extension-host event loop and later opens use the cache.
- Limited startup transcript parsing to 32 MB per workspace and retained only the newest 120 turns per loaded chat while preserving total counts.
- Added Earlier/Newer paging on desktop and Android with constant client memory and variable-page boundary safety.
- Added explicit indexing and truncated-history states so background work never appears as indefinite loading or missing history.
- Fixed a poll fallthrough that alternated unchanged progressive pages with large-chat placeholders, causing visible flashing.
- Added change-only, privacy-safe history transition diagnostics in the Copilot Monitor output channel and browser console.
- Used bounded stable reads and combined primary/supplement budgets so concurrently growing transcript files cannot bypass memory limits.
- Rejected oversized live-export payloads before cloning, parsing, or retaining them in the monitor.
- Serialized sidebar refreshes so slow gateway startup cannot accumulate overlapping asynchronous work.

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
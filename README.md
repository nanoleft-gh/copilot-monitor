# GitHub Copilot Monitor

Experimental VS Code extension for viewing local GitHub Copilot chats in a browser and sending prompts back to the exact VS Code window and chat session.

The browser dashboard is the foundation for a later Android wrapper. Every open VS Code window runs a hidden loopback bridge, while one window owns a shared LAN gateway on a stable port. The browser sees one URL and can switch between all live windows and chats.

## Current Features

- Discovers every open VS Code window through per-window heartbeat descriptors.
- Shows all persisted local Copilot chats for each live window.
- Reconstructs the session transcript from VS Code's append-only chat operation log.
- Streams live in-memory transcript and working-state changes with Server-Sent Events.
- Shows assistant markdown, code blocks, and summarized tool activity.
- Renders compact semantic headings, lists, quotes, rules, inline code, and emphasis instead of exposing raw markdown spacing.
- Renders fenced `mermaid` blocks as self-hosted, theme-aware SVG diagrams without a CDN.
- Shows live terminal command, cwd, output, exit code, and duration inside tool activity.
- Allows one-time terminal command approval or skip after exact window/session/request/tool validation.
- Routes selection and prompts by both `windowId` and session resource.
- Lists every currently selectable Copilot model for each VS Code window, including Auto.
- Shows the selected model, the model used by the latest request, thinking effort, context tier, and available configuration choices.
- Changes the model for the exact selected window and chat session.
- Changes thinking effort and context size for the exact selected window and chat, then briefly reloads that chat so VS Code restores the new configuration through its native editor-scoped store.
- Places model, effort, and context controls in a compact Copilot-style composer toolbar.
- Adds a workspace/conversation navigator, per-turn message rail, conversation search, and top/bottom navigation.
- Supports persistent light and dark themes from the dashboard toolbar.
- Exports complete conversations as Markdown by copying to the clipboard or downloading a `.md` file.
- Keeps persisted session identity separate from live response overlays.
- Deduplicates submitted message IDs and reports accepted, completed, and failed states.
- Exposes one tokenless dashboard URL on the trusted local network.
- Elects the gateway owner by binding the shared port and automatically fails over when that window closes.
- Requires no proposed API and no special launch flags.

## Run From Source

Requirements:

- VS Code 1.128 or newer
- Node.js 22 or newer
- GitHub Copilot extension

Install and validate:

```sh
npm install
npm test
```

Press `F5` to open the Extension Development Host. In that window:

1. Open the GitHub Copilot Chat panel and start or continue a local chat.
2. Run `Copilot Monitor: Open Dashboard` from the Command Palette.
3. Submit text in the dashboard and confirm it appears in the same Copilot panel.

## Install As A VSIX

```sh
npm run package
code --install-extension githubcopilot-monitor-0.5.1.vsix
```

Reload VS Code. The bridge starts automatically, adds a `Copilot Monitor` status bar item, and needs no proposed-API or launch flags.

## Phone Access

1. Connect the phone and computer to the same trusted Wi-Fi network.
2. Reload each VS Code window after installing the extension.
3. Run `Copilot Monitor: Copy Dashboard URL` in any window.
4. Open that URL on the phone.

All windows publish through the same port and URL. Windows Firewall may ask whether VS Code can accept private-network traffic. The gateway intentionally has no authentication; do not expose it to guest Wi-Fi or the public internet.

## Settings

- `githubCopilotMonitor.autoStart`: register each VS Code window with the shared gateway after startup. Default: `true`.
- `githubCopilotMonitor.port`: stable LAN gateway port shared by all windows. Default: `43121`.

## Commands

- `Copilot Monitor: Start Dashboard`
- `Copilot Monitor: Stop Dashboard`
- `Copilot Monitor: Open Dashboard`
- `Copilot Monitor: Copy Dashboard URL`

## Prototype Boundaries

- Only local VS Code Copilot chats are included; Copilot CLI, cloud-agent, and Agent Host sessions are outside this prototype.
- Hidden loopback ports are implementation details. Only the shared gateway port is exposed to the LAN.
- A crashed window remains visible for at most one heartbeat timeout before being removed.
- Prompt submission prefers an internal, undocumented VS Code command and otherwise falls back to the active chat view. Both paths depend on VS Code internals and must be re-checked as VS Code evolves.
- Exact model switching opens the selected chat in an editor before applying VS Code's `modelSelector`, preventing another open chat widget from receiving the change.
- VS Code 1.128 exposes no command or extension API for its editor-scoped model configuration setter. The bridge safely closes an idle exact chat, waits for VS Code to persist and release it, appends one validated input-state mutation, mirrors the profile default, and reopens the chat through VS Code's normal restore path. Chats with active responses, confirmations, or modified pending edits are not changed.
- Remote tool decisions are intentionally limited to one-time Allow/Skip. Persistent auto-approval is not exposed.
- This is a development prototype, not a Marketplace-ready extension.

## Validation

`npm test` runs TypeScript compilation, ESLint, model inventory/configuration tests, transcript/cache tests, terminal parsing and approval guards, window registry tests, exact cross-window routing tests, single-port gateway tests, and leader failover tests. `npm run test:integration` launches VS Code and fetches the tokenless gateway dashboard and aggregate state.

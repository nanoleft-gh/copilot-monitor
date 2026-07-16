# Copilot Monitor

Monitor and control local GitHub Copilot Chat sessions from a responsive browser dashboard. Switch among open VS Code windows and conversations, follow responses and tools in real time, send prompts, manage models and approvals, organize chats, and use the dashboard from another device on your trusted local network.

Every open VS Code window runs a hidden loopback bridge, while one window owns the shared LAN gateway on a stable port. The browser sees one URL and can route actions to the exact window and chat session.

> [!IMPORTANT]
> Copilot Monitor is an independent open-source project. It is not affiliated with, endorsed by, or supported by GitHub or Microsoft.

## Security

The dashboard intentionally has **no authentication**. Anyone who can reach its LAN URL can read local Copilot transcripts and may be able to send prompts, change chat settings, approve individual tool calls, or enable Bypass Approvals/Autopilot for a chat.

- Use it only on a private, trusted network.
- Do not expose port `43121` to the public internet, guest Wi-Fi, tunnels, or port-forwarding.
- Review Windows Firewall prompts and allow private networks only.
- Stop the dashboard from the Command Palette when it is not needed.

## Current Features

- Discovers every open VS Code window through per-window heartbeat descriptors.
- Shows all persisted local Copilot chats for each live window.
- Reconstructs the session transcript from VS Code's append-only chat operation log.
- Streams live in-memory transcript and working-state changes with Server-Sent Events.
- Keeps long chats responsive with bounded transcript rendering, sampled message jumpers, lightweight inactive-chat summaries, and throttled live exports.
- Shows assistant markdown, code blocks, and summarized tool activity.
- Renders compact semantic headings, lists, quotes, rules, inline code, and emphasis instead of exposing raw markdown spacing.
- Renders fenced `mermaid` blocks as self-hosted, theme-aware SVG diagrams without a CDN.
- Shows live terminal command, cwd, output, exit code, and duration inside tool activity.
- Allows one-time tool approval or skip after exact window/session/request/tool validation.
- Routes selection and prompts by both `windowId` and session resource.
- Lists every currently selectable Copilot model for each VS Code window, including Auto.
- Shows the selected model, the model used by the latest request, thinking effort, context tier, and available configuration choices.
- Changes the model for the exact selected window and chat session.
- Synchronizes native VS Code model and effort/context changes back to the dashboard through lightweight application-state polling.
- Changes thinking effort and context size for the exact selected window and chat, then briefly reloads that chat so VS Code restores the new configuration through its native editor-scoped store.
- Places model, effort, and context controls in a compact Copilot-style composer toolbar.
- Adds a workspace/conversation navigator, per-turn message rail, conversation search, and top/bottom navigation.
- Organizes conversations into persistent collapsible Todo, In Progress, Review, Done, and custom board columns with drag/drop, keyboard-accessible movement, and pinning.
- Creates and renames exact-window local chats from the dashboard.
- Changes per-chat approval mode between Default, Bypass Approvals, and Autopilot with an explicit safety confirmation.
- Supports persistent light and dark themes from the dashboard toolbar.
- Exports complete conversations as Markdown by copying to the clipboard or downloading a `.md` file.
- Keeps persisted session identity separate from live response overlays.
- Deduplicates submitted message IDs and reports accepted, completed, and failed states.
- Exposes one tokenless dashboard URL on the trusted local network.
- Elects the gateway owner by binding the shared port and automatically fails over when that window closes.
- Requires no proposed API and no special launch flags.

## Install

Install **Copilot Monitor** from the Visual Studio Marketplace, or use the command line:

```sh
code --install-extension nanoleft.githubcopilot-monitor
```

Reload every open VS Code window after installing or updating so all windows run the same gateway API version.

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

## Install From A VSIX

```sh
npm run package
code --install-extension githubcopilot-monitor-1.0.2.vsix --force
```

Reload VS Code. The bridge starts automatically, adds a `Copilot Monitor` status bar item, and needs no proposed-API or launch flags.

## Phone Access

1. Connect the phone and computer to the same trusted Wi-Fi network.
2. Reload each VS Code window after installing the extension.
3. Run `Copilot Monitor: Copy Dashboard URL` in any window.
4. Open that URL on the phone.

All windows publish through the same port and URL. Windows Firewall may ask whether VS Code can accept private-network traffic. See [Security](#security) before opening the dashboard from another device.

## Settings

- `githubCopilotMonitor.autoStart`: register each VS Code window with the shared gateway after startup. Default: `true`.
- `githubCopilotMonitor.port`: stable LAN gateway port shared by all windows. Default: `43121`.

## Commands
`ctrl+shift+p` -> 
- `Copilot Monitor: Start Dashboard`
- `Copilot Monitor: Stop Dashboard`
- `Copilot Monitor: Open Dashboard`
- `Copilot Monitor: Copy Dashboard URL`

## Known Limitations for Future Scope

- Only local VS Code Copilot chats are included; Copilot CLI, cloud-agent, and Agent Host sessions are outside this prototype.
- Hidden loopback ports are implementation details. Only the shared gateway port is exposed to the LAN.
- A crashed window remains visible for at most one heartbeat timeout before being removed.
- Prompt submission prefers an internal, undocumented VS Code command and otherwise falls back to the active chat view. Both paths depend on VS Code internals and must be re-checked as VS Code evolves.
- Exact model switching opens the selected chat in an editor before applying VS Code's `modelSelector`, preventing another open chat widget from receiving the change.
- VS Code 1.128 exposes no command or extension API for its editor-scoped model configuration setter. The bridge safely closes an idle exact chat, waits for VS Code to persist and release it, appends one validated input-state mutation, mirrors the profile default, and reopens the chat through VS Code's normal restore path. Chats with active responses, confirmations, or modified pending edits are not changed.
- Bypass Approvals and Autopilot are per-chat settings and require an explicit dashboard warning unless the user chooses not to show it again.
- Several chat operations depend on undocumented VS Code workbench commands and persisted chat formats. They are validated against the minimum supported VS Code version but may require updates when VS Code internals change.

## Validation

`npm test` runs TypeScript compilation, ESLint, model inventory/configuration tests, transcript/cache tests, terminal parsing and approval guards, window registry tests, exact cross-window routing tests, single-port gateway tests, and leader failover tests. `npm run test:integration` launches VS Code and fetches the tokenless gateway dashboard and aggregate state.

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


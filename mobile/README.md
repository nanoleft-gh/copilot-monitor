# Copilot Monitor Mobile

The Copilot Monitor mobile app connects to the local gateway exposed by the
Copilot Monitor VS Code extension. It can follow GitHub Copilot Chat sessions,
send and edit requests, select models and model configuration, change approval
modes, and approve pending tools from an Android or iOS device.

The application is built with Expo and React Native. Expo is the project
toolchain and native build system; it does not mean the released application is
the Expo Go app. Expo Go is used only for rapid development. Production releases
are standalone Android and iOS applications with the Copilot Monitor package,
name, icon, permissions, and update channel.

## Requirements

- Node.js 22 or newer
- pnpm 10 or newer
- A computer running VS Code with the Copilot Monitor extension
- The phone and computer on the same trusted local network

Platform-specific development additionally requires:

- Android: Android Studio/SDK and ADB for emulator or native builds
- iOS local builds: macOS and Xcode
- iOS cloud builds/App Store distribution: an Apple Developer account

## Install and Validate

From this directory:

```bash
pnpm install --frozen-lockfile
pnpm validate
```

`pnpm validate` runs the TypeScript compiler and Expo ESLint configuration.

## Development With Expo Go

Start Metro on the project development port:

```bash
pnpm go
```

Metro prints an `exp://` URL and QR code. Open the URL with Expo Go on a phone
connected to the same network.

Expo Go is appropriate for UI and JavaScript development. It uses Expo's
launcher icon and native container, so native metadata such as the final app
icon is visible only in a development or production build.

### Physical Android Device

Confirm that ADB can see the device:

```bash
adb devices -l
```

When direct LAN access to Metro is unavailable, reverse the development port:

```bash
adb -s <DEVICE> reverse tcp:18086 tcp:18086
adb -s <DEVICE> shell am start \
  -a android.intent.action.VIEW \
  -d 'exp://127.0.0.1:18086' \
  host.exp.exponent
```

Replace `<DEVICE>` with the identifier reported by `adb devices`.

### iPhone With Expo Go

1. Install Expo Go from the App Store.
2. Start Metro with `pnpm go`.
3. Scan Metro's QR code with the Camera app or Expo Go.
4. Accept the local-network and camera permission prompts.

An iPhone cannot use `adb reverse`; it must reach the Metro address over the
local network or through an Expo development tunnel.

## Pair With VS Code

1. Install and start the Copilot Monitor VS Code extension.
2. Open the Copilot Monitor sidebar in VS Code.
3. In the mobile app, choose **Pair computer**.
4. Scan the QR code or paste the gateway URL.

The default gateway port is `43121`. Pairing stores the computer's persistent
host identity and current LAN endpoint. If the LAN address changes, the app
attempts bounded discovery on the phone's current `/24` subnet and accepts only
a gateway reporting the same persistent host identity.

The gateway is intentionally tokenless. Use it only on a trusted private
network and do not expose port `43121` to the public internet.

## Native Development Builds

Generate and run an Android development build:

```bash
pnpm android
```

On macOS with Xcode, generate and run an iOS development build:

```bash
pnpm ios
```

These commands create native projects locally. Generated `android/` and `ios/`
directories are ignored because Expo configuration is the source of truth.

## Production Builds

Expo Application Services can build both platforms. Install and initialize the
EAS CLI once:

```bash
pnpm dlx eas-cli login
pnpm dlx eas-cli build:configure
```

Build Android:

```bash
pnpm dlx eas-cli build --platform android
```

Build iOS:

```bash
pnpm dlx eas-cli build --platform ios
```

An iOS release requires Apple signing credentials and an Apple Developer
account. EAS can perform the iOS build in the cloud from Windows, but simulator
testing and local iOS builds still require macOS/Xcode.

Before publishing, update the application version/build numbers, run
`pnpm validate`, test a signed build on physical devices, and review the final
store permissions and screenshots.

## Platform Configuration

The shared Expo configuration lives in `app.json`.

- Android package: `com.nanoleft.copilotmonitor`
- iOS bundle identifier: `com.nanoleft.copilotmonitor`
- URL scheme: `copilot-monitor`
- Android permits cleartext traffic for the trusted local HTTP gateway.
- iOS includes local-network privacy text and an App Transport Security local
  networking exception for the HTTP gateway.
- Camera permission is used only to scan pairing QR codes.
- Persistent paired hosts are stored with AsyncStorage.

## iOS Compatibility Status

The UI and transport use cross-platform React Native and Expo APIs. Explicit
iOS handling is present for safe areas, keyboard frame changes, camera access,
local-network privacy, local HTTP transport, routing, storage, and SSE state.

However, Android testing does not prove perfect iOS behavior. The iOS app has
not yet been exercised on an iPhone or simulator in this project. Before an iOS
release, test at minimum:

- First-launch local-network and camera permissions
- QR and pasted-address pairing
- Foreground/background SSE reconnection
- Keyboard layout on pairing, chat, and historical request editing screens
- Model, effort, context, and approval controls
- New-chat and historical branch-edit flows
- LAN address rediscovery after changing Wi-Fi or hotspot
- Status bar and safe-area layout on phone and tablet sizes

Treat iOS as supported by design but unverified until that test matrix passes on
real Apple hardware or an Xcode simulator.

## Useful Commands

```bash
pnpm start       # Start Expo on the default port
pnpm go          # Start Expo on port 18086
pnpm android     # Run a native Android development build
pnpm ios         # Run a native iOS development build (macOS only)
pnpm web         # Start the web target
pnpm typecheck   # TypeScript only
pnpm lint        # Expo ESLint only
pnpm validate    # TypeScript and lint
```

## Troubleshooting

### Computer becomes unavailable after changing networks

Open the saved computer and use Refresh. The app tries the saved endpoint, the
standard gateway port, and then verified local-subnet discovery. If discovery
cannot find the matching host, confirm VS Code is running and scan the current
QR code again.

### Expo Go cannot load Metro on Android

Use `adb reverse tcp:18086 tcp:18086` and open
`exp://127.0.0.1:18086` as shown above.

### Existing VS Code windows expose old behavior

After force-installing an updated VSIX, run **Developer: Reload Window** in each
open VS Code window so its extension host loads the new JavaScript.

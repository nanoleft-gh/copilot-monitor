# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Run on a physical Android device (Expo Go)

This is the fast path used day to day. It ships only JavaScript to the prebuilt
Expo Go app, so it skips the slow native Gradle/CMake build entirely.

Prerequisites: the phone has Expo Go installed and is reachable over `adb`
(USB or Wi-Fi), and the phone is on the same network as this computer.

```bash
# 1. From the repo root, confirm the device is connected.
adb devices -l

# 2. Start the Metro bundler (leave this running).
cd mobile && pnpm go

# 3. In a second terminal, launch the app inside Expo Go.
#    Replace <DEVICE> with the id from `adb devices` and <LAN_IP> with the
#    "Metro: exp://<LAN_IP>:18086" address printed by step 2.
adb -s <DEVICE> shell am start -a android.intent.action.VIEW \
   -d 'exp://<LAN_IP>:18086' host.exp.exponent
```

If the phone cannot reach the computer's LAN IP (for example on a locked-down
network), fall back to `adb reverse` and localhost:

```bash
adb -s <DEVICE> reverse tcp:18086 tcp:18086
adb -s <DEVICE> shell am start -a android.intent.action.VIEW \
   -d 'exp://127.0.0.1:18086' host.exp.exponent
```

To reload after code changes, shake the device and tap Reload, or just save a
file while Metro is running. Press `Ctrl+C` in the Metro terminal to stop.

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

### Other setup steps

- To set up ESLint for linting, run `npx expo lint`, or follow our guide on ["Using ESLint and Prettier"](https://docs.expo.dev/guides/using-eslint/)
- If you'd like to set up unit testing, follow our guide on ["Unit Testing with Jest"](https://docs.expo.dev/develop/unit-testing/)
- Learn more about the TypeScript setup in this template in our guide on ["Using TypeScript"](https://docs.expo.dev/guides/typescript/)

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.

# Release Automation

The repository publishes three independent GitHub Release series from pushes to
`master`:

| Component | Version source | Tag | Artifact |
| --- | --- | --- | --- |
| VS Code extension | `extension/package.json` | `extension-vX.Y.Z` | `.vsix` |
| Android app | `mobile/package.json` and `mobile/app.json` | `android-vX.Y.Z` | `.apk` |
| iOS app (paused) | `mobile/package.json` and `mobile/app.json` | `ios-vX.Y.Z` | `.ipa` |

Android and iOS intentionally share the same user-facing mobile version, but
their tags are independent. For example, `android-v0.1.0` does not prevent an
`ios-v0.1.0` release.

The iOS workflow is currently paused because installable IPA distribution
requires paid Apple Developer Program signing. Its implementation remains in
the repository, but it has no push trigger and its manually dispatched gate is
guarded by the unset `ENABLE_IOS_RELEASE` repository variable. Android releases
continue independently.

## Version gate

Each workflow is path-filtered. When it runs, it validates the relevant version
and checks for its component-specific tag on the remote repository.

- Missing tag: validate, build, create the tag and GitHub Release.
- Existing tag: finish successfully without rebuilding or modifying the release.

To publish a new version, update the version and its changelog section in the
same commit. Mobile requires `mobile/package.json` and `mobile/app.json` to have
the same version.

## Extension setup

The extension workflow publishes the packaged VSIX to VS Code Marketplace and
then creates the matching GitHub Release. Add the `VSCE_PAT` repository secret
with Marketplace Manage permission for the `nanoleft` publisher. Duplicate
Marketplace versions are skipped safely so a missing GitHub Release can still
be recovered. The built-in `GITHUB_TOKEN` creates the scoped tag and release.

## Mobile build setup

Android compilation runs on the standard GitHub-hosted Ubuntu runner using EAS
local build tooling, so it does not consume EAS cloud build minutes. EAS is used
only to identify the project and securely retrieve its managed Android signing
credential. Signed iOS builds remain paused because they require Apple Developer
Program credentials.

Complete this once before enabling mobile release workflows:

1. Create an Expo account and install EAS CLI.
2. From `mobile/`, run `eas init` and commit the project link written to
   `mobile/app.json`.
3. Configure Android signing once so EAS can create or import the keystore that
   GitHub Actions retrieves during its local build:

   ```bash
   eas credentials:configure-build --platform android --profile github-android
   ```

4. Create an Expo personal/robot access token.
5. Add this GitHub Actions repository secret:

   - `EXPO_TOKEN`: Expo access token used by EAS CLI.

The EAS project ID is not a secret and is committed in `mobile/app.json`. The
Android workflow uses that link to retrieve the signing credential, builds the
APK on GitHub's runner, generates a SHA-256 checksum, and attaches both files to
the GitHub Release.

Android internal builds are installable APKs. iOS internal builds are ad hoc
IPAs and only install on devices included in the provisioning profile. A GitHub
Release does not bypass Apple's signing or device-registration requirements.

To re-enable iOS after enrolling in the Apple Developer Program, initialize the
iOS signing credentials and registered devices, restore the `master`/`mobile/**`
push trigger in `.github/workflows/release-ios.yml`, set the repository variable
`ENABLE_IOS_RELEASE` to `true`, and validate the workflow with `actionlint`.

## GitHub settings

The workflows use the built-in `GITHUB_TOKEN` with `contents: write` only in
release jobs. Repository Actions settings must allow workflows to create tags
and releases. Branch protection should continue to require the desired checks
before commits reach `master`.

## Manual runs

All workflows support `workflow_dispatch`. A manual run still applies the same
version/tag gate, so rerunning a published version is a safe no-op.
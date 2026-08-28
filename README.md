# Splice Desktop

Cross-platform desktop client for [Navidrome](https://www.navidrome.org/) and
Subsonic-compatible servers — macOS, Windows, and Linux from one Tauri 2 + React +
Rust codebase.

Splice opens on server login and never substitutes a bundled demo library. After you
authenticate, it renders only what your own server returns.

## Download

Grab an installer from the [latest release](../../releases/latest):

| Platform | File |
| --- | --- |
| Windows | `.msi` or `.exe` (NSIS) |
| Linux | `.AppImage` or `.deb` |
| macOS | build locally — see below |

**You need your own server.** Splice is a client, not a music service. Point it at a
Navidrome or Subsonic-compatible server you already run.

### macOS

macOS installers are deliberately not published. Signing them requires a paid Apple
Developer ID certificate; without one, the only thing CI could produce is an unsigned
DMG that Gatekeeper refuses on any Mac except the one that built it — the recipient
would have to right-click → Open or strip the quarantine attribute by hand. Shipping
an installer that needs those instructions is worse than shipping none.

Build it yourself instead:

```sh
npm install
npm run tauri:build:mac
```

That signs against a code-signing identity already in your Keychain, which is fine for
your own machine and is not distributable.

## Features

Full-library navigation, server search, protected artwork and audio, playback and
queue controls, Liked Songs, playlist creation, session restore, and Splice Connect.

## Development

Requirements: Node.js 20+, Rust stable, and the platform prerequisites listed by
[Tauri](https://tauri.app/start/prerequisites/).

```sh
npm install
npm run test
npm run build
npm run tauri dev
```

On macOS, use `npm run tauri:dev:mac` for normal development. It signs each rebuilt
Rust executable with the same installed Apple identity and the `com.splice.desktop`
identifier before launch. After choosing **Always Allow** on the first Keychain
authorization, later development launches should not ask for your login password
again. The cross-platform `npm run tauri dev` still works, but its unsigned macOS
executable can trigger a fresh Keychain prompt after each rebuild.

### Builds

Native distributables must be built on their target operating system: macOS produces
an app/DMG, Windows produces MSI/NSIS installers, and Linux produces AppImage/deb/rpm
packages.

CI builds **Windows and Linux only**, attaching installers to the run's Artifacts, or
to a draft GitHub release on a `v*` tag.
[`.github/workflows/desktop-installers.yml`](.github/workflows/desktop-installers.yml)
documents what to change if a Developer ID certificate is obtained later.

## License

[GNU GPL v3.0 or later](LICENSE).

You may use, modify and redistribute Splice Desktop freely. If you distribute a
modified version, it must also be released under the GPL with its source available.

The iOS, tvOS and watchOS clients are separate, closed-source products and are not
covered by this license.

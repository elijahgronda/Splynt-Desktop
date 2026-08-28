<p align="center">
  <img src="assets/icon.png" alt="Splice" width="140">
</p>

<h1 align="center">Splice Desktop</h1>

<p align="center">
  Cross-platform desktop client for <a href="https://www.navidrome.org/">Navidrome</a>
  and Subsonic-compatible servers.<br>
  macOS, Windows and Linux from one Tauri 2 + React + Rust codebase.
</p>

<p align="center">
  <a href="https://discord.gg/kkaZfRpsm"><strong>Join the Discord →</strong></a><br>
  <sub>Questions, bug reports and release announcements.</sub>
</p>

---

Splice opens on server login and never substitutes a bundled demo library. After you
authenticate, it renders only what your own server returns.

> **Coming to Apple devices.** The main Splice app for iPhone, iPad and Apple TV is
> arriving on **TestFlight soon**. Join the [Discord](https://discord.gg/kkaZfRpsm)
> to get the invite when it goes out.

## Download

Grab an installer from the [latest release](../../releases/latest):

| Platform | File |
| --- | --- |
| Windows | `.exe` (NSIS) or `.msi` |
| Linux | `.AppImage` or `.deb` |

**You need your own server.** Splice is a client, not a music service. Point it at a
Navidrome or Subsonic-compatible server you already run.

Builds are not signed for public distribution, so Windows SmartScreen may ask for
confirmation on first launch — choose **More info → Run anyway**.

## Features

- **Full library browsing** — Home, Search, Library, albums, artists, playlists and
  Liked Songs, backed live by your own server
- **Daily Mix & listening stats** — personalized mixes generated from your library,
  plus top songs, artists and albums, listening clock, streaks and habits
- **Splice Connect** — discover and hand off playback between your devices, with
  shared queue and transport control
- **Offline downloads** — per-server download management with in-flight/failed state
  and disk preflight checks
- **Multi-server support** — library index, downloads and cached shelves are scoped
  per connected server
- **Secure by default** — credentials stored in the OS keychain; artwork and audio are
  proxied without exposing your API token

## Development

Requirements: Node.js 20+, Rust stable, and the platform prerequisites listed by
[Tauri](https://tauri.app/start/prerequisites/).

```sh
npm install
npm run test
npm run build
npm run tauri dev
```

Native distributables must be built on their target operating system. CI builds
Windows and Linux installers, attaching them to the run's Artifacts, or to a draft
GitHub release on a `v*` tag.

## License

[GNU GPL v3.0 or later](LICENSE).

You may use, modify and redistribute Splice Desktop freely. If you distribute a
modified version, it must also be released under the GPL with its source available.

The iOS, tvOS and watchOS clients are separate, closed-source products and are not
covered by this license.

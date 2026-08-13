# Changelog

All notable changes to Hybrid Command Center are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 3.0.0 were not recorded in this file; `git log` is authoritative for them.
The version a card ships as is decided at merge time — see the bump rule in `AGENTS.md`.

## [4.1.1] - 2026-08-13

### Fixed

- The Google Drive card on Settings no longer runs on into several hundred pixels of blank
  white space. It was being stretched to the height of the two cards beside it, so it stood
  more than a thousand pixels taller than the content it held; it now ends where its content
  ends, in every Drive state — credentials missing, disconnected, connected without a root
  folder, and connected with one set. Every other Settings card sizes to its content in the
  same way, which also closes the shorter gap that sat under Local timezone. Settings is
  around 400px shorter to scroll at desktop width, and the single-column layout below 1100px
  is unchanged.

### Breaking changes

None.

## [4.1.0] - 2026-08-13

### Fixed

- The Description and Notes labels on Task details no longer sit flush against the box you
  type into. Both inline editors now leave 10px between the label and its textarea, so the
  field reads as a labelled field rather than as one block of text. Every other form in the
  app — Settings, Task, Project, Client, and the Signal editor — is unchanged.

### Breaking changes

None.

## [4.0.0] - 2026-08-13

A version-only major bump. The application code, HTTP API, database schema, and
configuration are byte-for-byte unchanged from 3.1.3.

### Changed

- `package.json`, both `package-lock.json` version fields, and `APP_VERSION` in
  `shared/branding.ts` moved to `4.0.0`. `server/version-consistency.test.ts` holds all
  four to the same value, and `npm run check:version-bump` gates the result in CI.
- The version the sidebar foot, the Settings pane, and `GET /api/branding` report now reads
  `v4.0.0`.

### Added

- This changelog.

### Breaking changes

None. Nothing was removed, renamed, or given different behaviour, so no upgrade step
applies: the major digit was raised on request rather than to signal an incompatibility.
Semantic Versioning reserves the major position for incompatible API changes, so a future
reader should not infer one from this release.

## [3.1.3] - 2026-08-12

### Fixed

- The server refuses a non-loopback bind while nothing authenticates, rather than exposing
  an unauthenticated instance by a `HOST` change alone.

## [3.1.2]

### Changed

- The import and Drive routes carry request budgets.

## [3.1.1]

### Added

- CI measures coverage and holds each project to its own floor.
- Drive scope exposure and revocation are documented.

## [3.1.0]

### Added

- A private single-instance cloud shape is recommended for Infra 2, in `docs/cloud-hosting.md`.

## [3.0.3]

### Added

- Backups carry a retention count, and the restore rehearsal carries a schedule.

## [3.0.2]

### Added

- Supply-chain gates in CI.

## [3.0.1]

### Fixed

- The branding reset waits to reach the form before it resolves.

## [3.0.0]

### Added

- The Signal planner: `signal_posts` is the only store of planned content, read through
  `SignalProvider`, which has no write method by construction.

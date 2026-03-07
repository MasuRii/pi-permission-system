# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.4] - 2026-03-07

### Added
- Added permission request forwarding so non-UI subagent sessions can surface `ask` confirmations back to the main interactive session.
- Added filesystem-based request/response handling for both primary and legacy permission-forwarding directories.

### Changed
- Updated README documentation to describe subagent permission forwarding behavior and current architecture responsibilities.
- Added `package-lock.json` to the repository for reproducible local installs.

### Fixed
- Preserved interactive `ask` permission flows for delegated subagents that would otherwise fail without direct UI access.
- Improved cleanup and compatibility handling around legacy permission-forwarding directories.

## [0.1.3] - 2026-03-04

### Fixed
- Use absolute GitHub raw URL for README image to fix npm display

## [0.1.2] - 2026-03-04

### Changed
- Rewrote README.md with professional documentation standards
- Added comprehensive feature documentation, configuration reference, and usage examples

## [0.1.1] - 2026-03-02

### Changed
- Added `asset/` to the npm package `files` whitelist so README image assets are included in tarballs.

## [0.1.0] - 2026-03-02

### Changed
- Reorganized repository structure to match standard extension layout:
  - moved implementation and tests into `src/`
  - added root `index.ts` shim for Pi auto-discovery
  - standardized TypeScript project settings with Bundler module resolution
- Added package distribution metadata and scripts, including `pi.extensions` and publish file whitelist.
- Added repository scaffolding files (`README.md`, `CHANGELOG.md`, `LICENSE`, `.gitignore`, `.npmignore`) and config starter template.

### Preserved
- Global permission config path semantics remained `~/.pi/agent/pi-permissions.jsonc`.
- Permission schema location remained `schemas/permissions.schema.json`.
- Permission enforcement behavior remained intact.

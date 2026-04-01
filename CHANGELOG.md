# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-04-01

### Changed
- Updated npm keywords for improved discoverability (`pi-coding-agent`, `coding-agent`, `access-control`, `authorization`, `security`)
- Updated README permission prompt example image
- Added Related Pi Extensions cross-linking section to README

## [0.4.0] - 2026-04-01

### Added
- System prompt sanitizer now removes inactive tool guidelines from the `Guidelines:` section
- Guideline filtering based on allowed tools (e.g., removes task/mcp/bash/write guidance when tools are denied)
- New `TOOL_GUIDELINE_RULES` configuration for extensible guideline filtering
- Helper functions: `findSection()`, `removeLineSection()`, `sanitizeGuidelinesSection()`

### Changed
- Updated `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` peer dependencies to ^0.64.0
- Updated `@sinclair/typebox` peer dependency to ^0.34.49
- Refactored system prompt sanitizer to handle both `Available tools:` and `Guidelines:` sections

### Tests
- Added tests for system prompt sanitizer removing Available tools section
- Added tests for guideline filtering based on allowed tools
- Added tests for inactive built-in write/edit/task/mcp guidance removal

## [0.3.1] - 2026-03-24

### Added
- Permission system status module (`status.ts`) to expose yolo mode status to the UI
- `syncPermissionSystemStatus()` function to sync status with the TUI status bar
- `PERMISSION_SYSTEM_STATUS_KEY` and `PERMISSION_SYSTEM_YOLO_STATUS_VALUE` constants for status identification

### Changed
- Integrated status sync on config load, config save, and extension unload
- Status is only exposed when yolo mode is enabled

### Tests
- Added test for permission-system status being undefined when yolo mode is disabled and "yolo" when enabled

## [0.3.0] - 2026-03-23

### Added
- Yolo mode for auto-approval when enabled — bypasses permission prompts for streamlined workflows
- Permission forwarding system for subagent-to-primary IPC communication
- Configuration modal UI with Zellij integration (`config-modal.ts`, `zellij-modal.ts`)
- `permission-forwarding.ts` module for subagent permission request routing
- `yolo-mode.ts` module for automatic permission approval when yolo mode is active

### Changed
- Updated `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` peer dependencies to ^0.62.0
- Refactored `index.ts` to export new permission resolution utilities
- Expanded `extension-config.ts` with config normalization for new features
- Added `types-shims.d.ts` for Zellij modal type definitions

### Tests
- Added comprehensive tests for config modal functionality
- Added tests for permission forwarding behavior

## [0.2.2] - 2026-03-13

### Changed
- Removed delegation task restriction logic — the `task` tool is no longer restricted to orchestrator agent only
- Simplified tool permission lookup to use explicit `tools` entries for arbitrary registered tools instead of MCP fallback
- Renamed `TOOL_PERMISSION_NAMES` to `BUILT_IN_TOOL_PERMISSION_NAMES` to clarify it covers only canonical Pi tools
- Updated schema descriptions for `tools` and `mcp` fields to guide configuration usage

### Removed
- Removed delegation-specific permission checks (`isDelegationAllowedAgent`, `getDelegationBlockReason`) from permission evaluation

### Tests
- Added comprehensive test coverage for tool permission lookup behavior

## [0.2.1] - 2026-03-13

### Added
- Extension configuration system (`config.json`) with `debugLog` and `permissionReviewLog` options
- JSONL debug logging to `logs/pi-permission-system-debug.jsonl` when `debugLog` is enabled
- JSONL permission review logging to `logs/pi-permission-system-permission-review.jsonl` for auditing
- Permission request event emission on `pi-permission-system:permission-request` channel for external consumers
- New `extension-config.ts` module for config file management and path resolution
- New `logging.ts` module with `createPermissionSystemLogger` for structured log output

### Changed
- Replaced `console.warn`/`console.error` calls with structured logging to file
- Permission forwarding now logs request creation, response received, timeout, and user prompts
- Updated README documentation to cover extension config, logging, and event emission

## [0.2.0] - 2026-03-12

### Added
- `getToolPermission()` method to retrieve tool-level permission state without evaluating command-level rules, useful for tool injection decisions

## [0.1.8] - 2026-03-10

### Changed
- Refactored pattern compilation to support multiple sources for proper global+agent pattern merging
- Simplified `wildcard-matcher.ts` by removing unused `wildcardCount` and `literalLength` properties
- `BashFilter` now accepts pre-compiled patterns via `BashPermissionSource` type
- Replaced `compilePermissionPatterns` with `compilePermissionPatternsFromSources` for cleaner API

### Fixed
- Permission pattern priority now correctly implements last-match-wins hierarchy (opencode-style)
- MCP tool-level deny no longer blocks specific MCP allow patterns

### Tests
- Updated tests to reflect last-match-wins behavior
- Added test for specific MCP rules winning over `tools.mcp: deny`
- Rearranged test pattern declarations for clarity

## [0.1.7] - 2026-03-10

### Added
- `src/common.ts` — Shared utility module with `toRecord()`, `getNonEmptyString()`, `isPermissionState()`, `parseSimpleYamlMap()`, `extractFrontmatter()`
- `src/wildcard-matcher.ts` — Wildcard pattern compilation and matching with specificity sorting
- File stamp caching in `PermissionManager` for improved performance
- `tools.mcp` fallback permission for MCP operations
- MCP tool permission targets now inferred from configured server names in `mcp.json`

### Changed
- Refactored `bash-filter.ts` to use shared `wildcard-matcher.ts` module
- Refactored `index.ts` to use shared `common.ts` utilities
- Refactored `permission-manager.ts` to use shared modules and caching
- Pre-compiled wildcard patterns are now reused across permission checks
- Updated README architecture documentation to reflect new module organization

### Tests
- Added tests for MCP proxy tool inferring server-prefixed aliases from configured server names
- Added tests for `tools.mcp` fallback behavior
- Added tests for `task` using tool permissions instead of MCP fallback

## [0.1.6] - 2026-03-09

### Added
- Sanitized the `Available tools:` system prompt section so denied tools are removed before the agent starts.

### Changed
- Updated README documentation to describe system-prompt tool sanitization and refreshed the displayed package version.

### Fixed
- Prevented hidden tools from remaining advertised in the startup system prompt after runtime tool filtering.

## [0.1.5] - 2026-03-09

### Changed
- Added `repository`, `homepage`, and `bugs` package metadata so npm links back to the public GitHub repository and issue tracker.

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

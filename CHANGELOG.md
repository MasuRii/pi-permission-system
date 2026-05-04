# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Permission-system config parsing now accepts JSONC comments and trailing commas across both policy files and the extension config, and invalid config warnings are emitted once per session as a compact single-line message with explicit fallback behavior.

### Fixed
- Stopped repeating identical invalid-config warnings in the TUI when the same broken permission policy is re-evaluated during the same session or reload cycle (thanks to @jviel-beta for issue #20).

## [0.4.8] - 2026-05-04

### Added
- Added runtime yolo-mode control through the `/permission-system` settings modal and `globalThis.__piPermissionSystem` for other extensions.
- Added wildcard support for `permission.tools` so direct tools from any extension can be controlled without adapter-specific hardcoding.
- Added `PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR` so global policy and global agent override lookup can be pointed at a different agent root when needed.

### Changed
- Simplified `/permission-system` to only open the settings modal, removing the previous `show`, `path`, `reset`, `help`, and `yolo ...` subcommands.
- Expanded the README with an OpenCode-to-Pi migration guide covering agent file placement, frontmatter structure, permission mapping, Pi-specific `tools` vs `mcp` behavior, and policy-root overrides.

### Fixed
- Removed artifact validation that forced local runtime `config.json` values to match release defaults.
- Restored requested bash command text in permission review log entries while keeping prompts and generic tool payload previews redacted.
- Clarified last-declared-match wildcard precedence in the README and fixed wildcard-order examples/recipes so documented `tools` and `mcp` examples now match runtime behavior (thanks to @Nateowami for issue #17 and @gotgenes for the rule-order diagnosis).
- Replaced the removed `session_switch` lifecycle subscription with a single supported `session_start` refresh path so session changes rebuild runtime permission state without duplicate handlers (thanks to @gotgenes for PR #11).
- Removed stale README wording around exact-name tool matching and refreshed the documented architecture/module list to match the current extension layout.

## [0.4.7] - 2026-05-04

### Added
- Documented `PI_PERMISSION_SYSTEM_CONFIG_PATH` and `PI_PERMISSION_SYSTEM_LOGS_DIR` overrides for custom config and log locations.
- Added artifact validation to release checks for config defaults, schema support, README references, and package script safety.

### Changed
- Enforced trusted global/system `deny` floors so project-local policy layers can tighten permissions without relaxing higher-trust denies.
- Switched permission review audit entries to metadata hashes and lengths for prompts, commands, denial reasons, and tool input previews instead of raw sensitive content.

### Fixed
- Stopped publishing `config.json` in the package so fresh installs use the runtime default with yolo mode off by default (thanks to @Nateowami for PR #18).

## [0.4.6] - 2026-04-28

### Added
- Added bounded, sanitized tool input previews to permission review logs for non-bash/non-MCP tool calls, inspired by PR #10 from @DevkumarPatel.

### Changed
- Reused the extension's safe JSON serialization path for generic tool approval previews so circular values and BigInts are summarized without raw full-input logging.
- Updated `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, and `@mariozechner/pi-tui` peer dependencies to `^0.70.5`.

## [0.4.5] - 2026-04-27

### Fixed
- Added a model option compatibility guard for OpenAI Responses/Codex streams so unsupported `temperature` values are removed from stream options and outgoing payloads before provider calls.

## [0.4.4] - 2026-04-25

### Added
- Added runtime enforcement for the `external_directory` special permission on path-bearing tools (`read`, `write`, `edit`, `find`, `grep`, `ls`) before normal tool permission checks (thanks to @gotgenes for PR #9)
- Added readable `ask` prompt summaries for built-in file tools and bounded input previews for generic extension tools so users can make informed approval decisions (thanks to @beantownbytes for PR #8)
- Added `skill-prompt-sanitizer.ts` to parse and sanitize every `<available_skills>` block, including prompts with multiple skill sections

### Changed
- Updated `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` peer dependencies to `^0.70.2`
- Refactored skill prompt filtering out of `src/index.ts` into a dedicated module for clearer ownership and reuse
- Permission prompts for `edit`, `write`, `read`, `find`, `grep`, and `ls` now show concise path/action summaries instead of raw multiline JSON

### Fixed
- Denied skills are now removed from all available-skill prompt blocks instead of only the first block
- Denied skill entries are no longer retained for later skill-read path matching after prompt sanitization
- External path access now honors `special.external_directory: deny` and blocks `ask` decisions when no UI or forwarding channel is available

### Tests
- Added runtime `tool_call` coverage for external directory deny, ask-without-UI, ask approval, internal path allow, and optional path omission
- Added prompt regression coverage for generic tool input previews and readable built-in file-tool approval summaries
- Added multi-block skill prompt sanitizer regression coverage

## [0.4.2] - 2026-04-20

### Added
- Added project-level permission layering from the active session workspace via `<cwd>/.pi/agent/pi-permissions.jsonc`
- Added project-level per-agent overrides via `<cwd>/.pi/agent/agents/<agent>.md` (thanks to @Talia-12 for PR #7)
- Added reload-aware permission manager refresh paths so policy caches are rebuilt when Pi reload events occur
- Added a dedicated `tests/` directory with modular test entrypoints and a shared test harness
- Added before-agent-start caching module to dedupe unchanged active-tool exposure and prompt state across `before_agent_start` lifecycle invocations
- Added `PermissionPromptDecision` type with `state` and `denialReason` fields for richer permission prompt resolution
- Added `getPolicyCacheStamp()` method to `PermissionManager` for cache invalidation tracking

### Changed
- Global path resolution now follows Pi's `getAgentDir()` helper, so global config, agents, sessions, and logs respect `PI_CODING_AGENT_DIR` (thanks to @jvortmann for PR #6)
- Updated `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` peer dependencies to `^0.67.68`
- Updated TypeScript project configuration and npm scripts to run tests from `tests/` instead of `src/`
- Updated README documentation for project-level policy files, yolo mode config, test layout, and `PI_CODING_AGENT_DIR`
- Permission prompts and forwarding now return `PermissionPromptDecision` instead of boolean for richer resolution tracking
- Permission denial messages now include user-provided denial reasons when available

### Removed
- Removed the legacy packaged `asset/` directory because the README now uses externally hosted images instead of repository-bundled screenshots

### Fixed
- `/skill:<name>` permission handling now falls back to the current merged skill policy when no active agent context is available in the main session (thanks to @NSBeidou and @hidromagnetismo for reporting the issue)
- Skill denial messaging now reflects whether the block came from an agent-specific rule or the merged policy without agent context

### Tests
- Added coverage for project-level precedence across global, project, system-agent, and project-agent layers
- Added coverage for resolving config from `PI_CODING_AGENT_DIR`
- Added coverage for before-agent-start cache key generation and state deduplication
- Added coverage for cache invalidation on permission policy changes

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

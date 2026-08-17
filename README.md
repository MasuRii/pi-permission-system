<div align="center">

# pi-permission-system

[![npm version](https://img.shields.io/npm/v/pi-permission-system?style=for-the-badge)](https://www.npmjs.com/package/pi-permission-system)
[![License](https://img.shields.io/github/license/MasuRii/pi-permission-system?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=for-the-badge)]()

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/Y8Y01PSSVR)

Permission enforcement extension for the Pi coding agent that provides centralized, deterministic permission gates for tool, bash, MCP, skill, and special operations.
<img width="1360" height="752" alt="image" src="https://github.com/user-attachments/assets/3e85190a-17fa-4d94-ac8e-efa54337df5d" />

</div>

## Coming from OpenCode?

Yes — this extension was designed so OpenCode-style agent permission policies can be ported into Pi with minimal friction.

### Start here

| If you have this in OpenCode | In Pi, use this |
|---|---|
| Agent markdown file | `~/.pi/agent/agents/<agent-name>.md` (respects `PI_CODING_AGENT_DIR`) |
| YAML frontmatter | Same place: top of the markdown file |
| Agent instructions / system prompt body | Same file, below frontmatter |
| Agent permission rules | `permission:` inside that same frontmatter |

### Important compatibility notes

- **Agents are still markdown files with YAML frontmatter.**
- **Wildcard permissions still use last-match-wins ordering.**
- **Resource-qualified path rules are supported for path-bearing tools.** Use action-scoped `tools` keys like `read:/home/alice/project/generated/*` and scoped special keys like `external_directory:/home/alice/shared/*` when you need OpenCode-style directory rules.
- **Keep frontmatter simple when porting.** This extension intentionally supports `key: value` scalars and nested maps, not full YAML features like arrays, anchors, or multiline scalars.

### Minimal Pi agent example

```md
---
name: my-agent
mode: primary
description: My ported agent
permission:
  tools:
    read: allow
    grep: allow
  bash:
    "*": ask
  mcp:
    "*": ask
---

Your agent instructions go here.
```

### Compatibility matrix

| OpenCode concept | Pi equivalent with this extension | Compatibility | Porting notes |
|---|---|---:|---|
| Agent markdown files with YAML frontmatter | `~/.pi/agent/agents/<agent-name>.md` | High | Your agent-local `permission:` frontmatter pattern carries over cleanly. |
| Wildcard precedence | Same last-declared-match-wins behavior | High | Broad rules first, specific overrides later. |
| `bash` permission rules | `permission.bash` | High | Command-pattern gating ports cleanly. |
| Per-tool permission rules like `read`, `grep`, `list`, `task`, or arbitrary extension tool names | `permission.tools` | Medium-High | Pi groups registered tool names under `tools`, including built-ins and extension tools. |
| `external_directory` | `permission.special.external_directory` or `permission.special.external_directory:<path>/*` | Medium-High | Coarse fallback stays supported; add resource-qualified rules for specific outside-worktree directories. |
| `doom_loop` | `permission.special.doom_loop` | Medium | Same idea, different location. |
| `skill` permission rules | `permission.skills` | Medium | Same purpose, but Pi uses a dedicated plural `skills` section. |
| MCP-related access | `permission.mcp` for proxy targets, `permission.tools` for direct registered tools | Medium | This is the biggest Pi-specific difference: proxy MCP targets and direct tool names are intentionally split. |
| OpenCode-specific permissions like `webfetch`, `websearch`, `question`, `lsp`, `todowrite` | Usually extension-specific Pi tool names under `permission.tools` | Low-Medium | These do not have universal built-in one-to-one Pi names; map them to the actual registered tools available in your Pi setup. |

### Most important difference

In OpenCode, many permission names live in one broad permission namespace. In Pi with this extension, there is a deliberate split:

| Use this when... | Put the rule here |
|---|---|
| You are targeting the registered **`mcp` proxy tool** and its internal server/tool targets | `permission.mcp` |
| You are targeting an actual registered tool name, including direct extension tools like `context7_*`, `github_*`, or `exa_*` | `permission.tools` |

### Fast porting guide

| If your OpenCode agent has... | In Pi, do this |
|---|---|
| `permission.bash` rules | Move them into `permission.bash` |
| `permission.external_directory` | Move it to `permission.special.external_directory` |
| `permission.doom_loop` | Move it to `permission.special.doom_loop` |
| `permission.skill` rules | Move them to `permission.skills` |
| Tool-ish permissions like `read`, `grep`, `list`, `task`, or third-party tool names | Put them in `permission.tools` |
| MCP server/tool target logic | Put proxy-target rules in `permission.mcp` |

### Practical takeaway

If you are coming from OpenCode, you usually do **not** need to rewrite your whole agent. In most cases, porting is just:

1. Keep the agent markdown/frontmatter structure.
2. Move OpenCode-style tool permissions into Pi's `tools` section.
3. Move `external_directory` and `doom_loop` into `special`.
4. Split MCP proxy target rules into `mcp` and direct registered tool rules into `tools`.

## Features

- **Tool Filtering** — Hides disallowed tools from the agent before it starts (reduces "try another tool" behavior)
- **System Prompt Sanitization** — Removes denied tool entries from the `Available tools:` system prompt section so the agent only sees tools it can actually call
- **Runtime Enforcement** — Blocks/asks/allows at tool call time with UI confirmation dialogs and readable approval summaries
- **Bash Command Control** — Wildcard pattern matching for granular bash command permissions
- **MCP Access Control** — Server and tool-level permissions for MCP operations
- **Skill Protection** — Controls which skills can be loaded or read from disk, including multi-block prompt sanitization and path-inferred reads under Pi skill directories
- **Per-Agent Overrides** — Agent-specific permission policies via YAML frontmatter
- **Subagent Permission Forwarding** — Forwards `ask` confirmations from non-UI subagents back to the main interactive session
- **Runtime YOLO Control** — Lets users toggle yolo mode from the settings modal and lets other extensions toggle it through the runtime API
- **File-Based Debug Logging** — Writes verbose diagnostics and permission request/denial review entries to one debug file when enabled in `config.json`, including the responsible agent and raw tool-call input
- **JSON Schema Validation** — Full schema for editor autocomplete and config validation
- **External Directory Guard** — Enforces `special.external_directory` for path-bearing file tools that target paths outside the active working directory

## Installation

### npm package

```bash
pi install npm:pi-permission-system
```

### Local extension folder

Place this folder in one of the following locations:

| Scope   | Path |
|---------|------|
| Global default | `~/.pi/agent/extensions/pi-permission-system` (respects `PI_CODING_AGENT_DIR`) |
| Project | `.pi/extensions/pi-permission-system` |

Pi auto-discovers extensions in these paths.

> **Tip:** All `~/.pi/agent` paths shown in this document are defaults. If the `PI_CODING_AGENT_DIR` environment variable is set, pi uses that directory instead. The extension automatically follows pi's `getAgentDir()` helper for extension installation, session directories, and extension-local config paths. If you need policy lookup to come from a different global agent root, set `PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR`.

## Usage

### Quick Start

1. Create the global policy file at the Pi agent runtime root (default: `~/.pi/agent/pi-permissions.jsonc`, respects `PI_CODING_AGENT_DIR`):

```jsonc
{
  "defaultPolicy": {
    "tools": "ask",
    "bash": "ask",
    "mcp": "ask",
    "skills": "ask",
    "special": "ask"
  },
  "tools": {
    "read": "allow",
    "write": "deny"
  }
}
```

2. Start Pi — the extension automatically loads and enforces your policy.

### Permission States

All permissions use one of three states:

| State   | Behavior                                    |
|---------|---------------------------------------------|
| `allow` | Permits the action silently                 |
| `deny`  | Blocks the action with an error message     |
| `ask`   | Prompts the user for confirmation via UI    |

When an `ask` permission prompts, the confirmation UI offers `Allow Once`, `Allow Always`, `Reject`, and `Reject with Reason`. `Allow Once` approves only the current request. `Allow Always` records an explicit matching approval for the current session only (in-memory, not persisted to disk), while plain `Reject` and `Reject with Reason` deny only the current request and do not silently become future defaults. YOLO/auto-response approvals also do not create saved approval rules; after YOLO mode is disabled, matching `ask` requests require approval again. A configured `deny` remains a hard boundary and is not relaxed by prior one-shot, auto-response, or saved approvals.

### Pi Integration Hooks

The extension integrates via Pi's lifecycle hooks:

| Hook                 | Behavior                                                                                  |
|----------------------|-------------------------------------------------------------------------------------------|
| `before_agent_start` | Filters active tools, removes denied tool entries from the system prompt, and hides denied skills |
| `tool_call`          | Enforces permissions for every tool invocation                                            |
| `input`              | Tracks explicit `/skill:<name>` requests so user-invoked skill loads can proceed while agent-initiated reads remain policy-gated |

**Additional behaviors:**
- Unknown/unregistered tools are blocked before permission checks (prevents bypass attempts)
- The `Available tools:` system prompt section is rewritten to match the filtered active tool set
- Extension-provided tools like `task`, `mcp`, and third-party tools are handled through the same registered-tool permission layer instead of private built-in hardcodes
- When a subagent hits an `ask` permission without direct UI access, the request can be forwarded to the main interactive session for confirmation
- Generic extension-tool approval prompts include a bounded input preview; built-in file tools use concise human-readable summaries instead of raw multiline JSON
- Debug review entries include the responsible agent, raw prompt, raw tool-call input, command, target, and decision metadata for auditing.
- Path-bearing file tools (`read`, `write`, `edit`, `find`, `grep`, `ls`) evaluate `special.external_directory` before their normal tool permission when an explicit path points outside `ctx.cwd`
- `read` calls under global and project Pi skill directories are checked against `skills` policy even when the skill entry is inferred from the path rather than an active prompt block.
- Structured edit payloads are summarized by operation and line count in prompts so permission decisions do not require raw multiline JSON.

## Configuration

### Extension Config File

**Location:** global Pi extension config (default: `~/.pi/agent/extensions/pi-permission-system/config.json`, respects `PI_CODING_AGENT_DIR`)

Set `PI_PERMISSION_SYSTEM_CONFIG_PATH` to point this extension at a specific config file when the default global path is not appropriate.

The extension creates this file automatically when it is missing. It controls extension-local debug logging behavior and yolo mode defaults:

```json
{
  "enabled": true,
  "debug": false,
  "yoloMode": false
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Master switch. When `false`, the extension skips all registrations and startup work (permission hooks, commands, runtime API, forwarding). |
| `debug` | `false` | Enables verbose diagnostics and permission review entries in `logs/pi-permission-system-debug.jsonl` |
| `yoloMode` | `false` | Auto-approves `ask` results instead of prompting when yolo mode is enabled |

Debug output writes only under the extension directory by default. Set `PI_PERMISSION_SYSTEM_LOGS_DIR` to redirect the debug file to a specific directory. No debug output is printed to the terminal.

### Runtime YOLO Control

Use `/permission-system` to open the settings modal and inspect or change yolo mode interactively. In interactive TUI mode, the settings modal uses Pi's renderer-provided theme and does not require a separate global `initTheme()` call before opening.

Other extensions can toggle yolo mode immediately through the shared runtime API:

```ts
type PermissionSystemGlobal = typeof globalThis & {
  __piPermissionSystem?: {
    toggleYoloMode(options?: { persist?: boolean; source?: string }): { error?: string };
  };
};

pi.registerShortcut("f8", {
  description: "Toggle pi-permission-system YOLO mode",
  handler: () => {
    const permissionSystem = (globalThis as PermissionSystemGlobal).__piPermissionSystem;
    const result = permissionSystem?.toggleYoloMode({ source: "my-extension" });
    if (result?.error) {
      // Notify or log the error in your extension.
    }
  },
});
```

The runtime API exposes `getYoloMode()`, `setYoloMode(enabled, options?)`, and `toggleYoloMode(options?)`. Runtime updates persist to `config.json` by default; pass `{ persist: false }` for a current-session-only toggle.

### Global Policy File

**Location:** global Pi policy file (default: `~/.pi/agent/pi-permissions.jsonc`, respects `PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR` when set and otherwise follows `PI_CODING_AGENT_DIR`)

The policy file is a JSON object with these sections:

| Section         | Description                                         |
|-----------------|-----------------------------------------------------|
| `defaultPolicy` | Fallback permissions per category                   |
| `tools`         | Pattern-based tool permissions for registered tools |
| `bash`          | Command pattern permissions                         |
| `mcp`           | MCP server/tool permissions for calls routed through a registered `mcp` tool |
| `skills`        | Skill name pattern permissions                      |
| `special`       | Reserved permission checks such as external directory access |

> **Note:** JSONC comments and trailing commas are supported. If parsing still fails, the extension falls back to `ask` for all categories and shows a warning in the TUI when available.

### Global Per-Agent Overrides

Override global permissions for specific agents via YAML frontmatter in the global Pi agents directory (default: `~/.pi/agent/agents/<agent-name>.md`, respects `PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR` when set and otherwise follows `PI_CODING_AGENT_DIR`):

```yaml
---
name: my-agent
permission:
  tools:
    read: allow
    write: deny
    mcp: allow
  bash:
    git status: allow
    git *: ask
  mcp:
    chrome_devtools_*: deny
    exa_*: allow
  skills:
    "*": ask
---
```

**MCP behavior:** `permission.tools.mcp` is the coarse entry/fallback permission for a registered `mcp` tool when one is available. More specific `permission.mcp` target rules override that fallback when they match.

**Limitations:** The frontmatter parser is intentionally minimal. Use only `key: value` scalars and nested maps. Avoid arrays, multi-line scalars, and YAML anchors. If you are porting from OpenCode, simplify richer YAML frontmatter before expecting a clean migration.

### Project-Level Policy Files

The extension can also layer project-local permission files relative to the active session working directory:

| Scope | Path |
|-------|------|
| Project policy | `<cwd>/.pi/agent/pi-permissions.jsonc` |
| Project agent override | `<cwd>/.pi/agent/agents/<agent-name>.md` |

Project-local files use the same formats as the global policy file and global agent frontmatter. These project files are resolved from Pi's current session `cwd`, so they are workspace-specific and do **not** move under `PI_CODING_AGENT_DIR`.

**Precedence order:**
1. Global policy file
2. Project policy file
3. Global agent frontmatter
4. Project agent frontmatter

Later trusted layers override earlier layers within the same permission category, and project-local layers can tighten policy by adding `deny` rules. Project-local policy cannot relax a `deny` from the global policy file or global agent frontmatter: an `allow` or `ask` in a project policy is ignored when the latest matching trusted layer is `deny`. For wildcard-based sections like `tools`, `bash`, `mcp`, `skills`, and `special`, matching still follows **last matching rule wins** within the applicable trust boundary, with global/system `deny` rules acting as floors for project-local overrides.

---

## Policy Reference

### `defaultPolicy`

Sets fallback permissions when no specific rule matches:

```jsonc
{
  "defaultPolicy": {
    "tools": "ask",
    "bash": "ask",
    "mcp": "ask",
    "skills": "ask",
    "special": "ask"
  }
}
```

### `tools`

Controls tools by registered name pattern. This is the recommended standalone format for **all** tool entries, including Pi built-ins and arbitrary third-party extension tools. Patterns use `*` wildcards and follow last-declared-match semantics, so put broad fallbacks first and specific overrides later.

| Tool name example     | Description |
|-----------------------|-------------|
| `bash`                | Shell command execution (tool-level fallback before `bash` pattern rules) |
| `read` / `write`      | Canonical Pi built-in file tools |
| `mcp`                 | Registered MCP proxy tool entry/fallback when available |
| `task`                | Delegation tool handled like any other registered extension tool |
| `third_party_tool`    | Arbitrary registered extension tool |
| `context7_*`          | Wildcard for direct tools registered by another extension |
| `*`                   | Fallback for every registered tool not matched by a later rule |

```jsonc
{
  "tools": {
    "*": "ask",
    "context7_*": "ask",
    "third_party_tool": "ask",
    "mcp": "allow",
    "read": "allow",
    "write": "deny"
  }
}
```

Unknown or absent tools are not required in the config. If another extension is not installed, its tool simply will not be registered at runtime, and this extension will block attempts to call that missing tool before permission checks run. Wildcard `tools` rules apply to direct tools from any extension; no adapter-specific naming is required.

Path-bearing built-ins (`read`, `write`, `edit`, `find`, `grep`, `ls`) can also use action/resource keys in `tools` with normalized absolute paths. Use this when a tool should be allowed or denied only for a specific directory resource:

```jsonc
{
  "tools": {
    "read": "ask",
    "read:/home/alice/project/generated/*": "allow",
    "write": "deny"
  }
}
```

Action-scoped resource rules still respect normal permission guardrails: matching uses the same wildcard/last-match behavior as other tool rules, and outside-worktree paths must also satisfy the `special.external_directory` check.

> **Note:** Setting `tools.bash` affects the *default* for bash commands, but `bash` patterns can provide command-level overrides.
>
> **Note:** Setting `tools.mcp` controls coarse access to a registered `mcp` proxy tool when one is available. Specific `mcp` rules still override it when a proxy target pattern matches. Direct MCP tools registered by extensions are regular registered tools and should be controlled with `tools` patterns such as `context7_*` or `github_*`.
>
> **Note:** Top-level shorthand is only supported for the canonical Pi built-ins (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`) in agent frontmatter. Use `permission.tools.<name>` for `mcp`, `task`, and any third-party tool.

### `bash`

Command patterns use `*` wildcards. Compound commands are split into segments on `&&`, `||`, `|&`, `;`, `|`, `&`, and newlines — every command and pipeline element is evaluated separately, and the **most restrictive** segment result wins (deny > ask > allow). If multiple patterns match a segment, the **last declared matching rule wins**. Put broad fallback rules first and more specific overrides later.

```jsonc
{
  "bash": {
    "git *": "ask",
    "git status": "allow",
    "rm -rf *": "deny"
  }
}
```

So `cd repo && bun tests/foo.test.ts 2>&1` is checked as two segments — `cd repo` and `bun tests/foo.test.ts 2>&1` — each matched independently. Trailing comments are ignored when matching (`git status # note` still matches the exact pattern `git status`).

**Opaque segments.** Commands containing constructs the tokenizer does not classify — command substitution `$(...)`, backticks, here-strings `<<<`, multiple heredocs on one line, unbalanced or unterminated quotes — are *opaque*: they skip pattern matching entirely and always resolve to `ask`, regardless of your patterns or default policy. This is deliberate: a pattern like `bun *` should not silently permit `bun $(curl ... | sh)`.

### `bashRedirect`

Optional policy for **output redirection targets** (`>`, `>>`, `&>`, `<>`). Opt-in: when this section is absent or empty, redirects do not affect the permission decision at all.

```jsonc
{
  "bashRedirect": {
    "*": "ask",
    "/dev/null*": "allow",
    "/dev/std*": "allow"
  }
}
```

Rules:
- Patterns match the redirect target, using the same wildcard syntax. **Last declared matching rule wins** — declare broad fallbacks like `*` first, specific overrides later.
- A redirect can only make a segment *more restrictive*: if any redirect target resolves to a state more restrictive than the segment's command state, the segment takes the redirect state. So `bun tests 2>&1` stays `allow` under the example policy (fd-dup is exempt), while `bun tests > /tmp/out.txt` becomes `ask`.
- **fd-dup redirects (`2>&1`, `10>&2`) are exempt** — they never write files and are not evaluated against patterns.
- **Input redirection `<` is exempt** (read-only).
- Targets that match no pattern resolve to the default bash state.
- Ask and deny prompts report the deciding target: `... (redirects to '/tmp/out.txt')`.

**Target normalization.** Redirect targets are normalized before matching so patterns can be written for canonical paths:
- Absolute paths are lexically resolved — `>` targets like `/tmp/../etc/foo` become `/etc/foo`, so `..` cannot evade a rule written for `/etc/*` (and an allow rule for `/tmp/*` cannot leak through it).
- `~` and `~/...` expand to your home directory — in command targets *and* in config patterns, so `{"~/secrets/*": "deny"}` works as expected.
- Relative targets are left as-is (the cwd at redirect time may differ from the cwd at evaluation time in compound commands like `cd x && cmd > out.txt`), so they simply don't match absolute-path rules and fall through to the default bash state.

Limitations: only redirections are inspected. Commands that write files through plain arguments (`tee file`, `sed -i`, `dd of=...`) are not covered, and redirects inside opaque constructs (e.g. `$(...)`) are not extracted.

### `mcp`

MCP permissions match against derived targets from tool input. These rules are more specific than `tools.mcp` and override that fallback when a pattern matches:

| Target Type       | Examples                                    |
|-------------------|---------------------------------------------|
| Baseline ops      | `mcp_status`, `mcp_list`, `mcp_search`, `mcp_describe`, `mcp_connect` |
| Server name       | `myServer`                                  |
| Server/tool combo | `myServer:search`, `myServer_search`        |
| Generic           | `mcp_call`                                  |

```jsonc
{
  "mcp": {
    "*": "ask",
    "myServer:*": "ask",
    "mcp_status": "allow",
    "mcp_list": "allow",
    "dangerousServer": "deny"
  }
}
```

> **Note:** Baseline discovery targets may auto-allow when you permit any MCP rule.

#### MCP Tool Fallback via `tools.mcp`

A registered `mcp` tool can use `tools.mcp` as an entry permission point. This provides a fallback when no specific MCP pattern matches:

```jsonc
{
  "tools": {
    "mcp": "allow"
  }
}
```

This is useful for per-agent configurations where you want to grant MCP access broadly:

```yaml
# In the global Pi agents directory (default: ~/.pi/agent/agents/researcher.md; respects PI_CODING_AGENT_DIR)
---
name: researcher
permission:
  tools:
    mcp: allow
---
```

The permission resolution order for MCP operations:
1. Specific `mcp` patterns (e.g., `myServer:toolName`, `myServer_*`)
2. `tools.mcp` fallback (if set)
3. `defaultPolicy.mcp`

### `skills`

Skill name patterns use `*` wildcards:

```jsonc
{
  "skills": {
    "*": "ask",
    "dangerous-*": "deny"
  }
}
```

Skill-read enforcement also applies when a `read` path is under the global Pi skills directory (`~/.pi/agent/skills` or `PI_CODING_AGENT_DIR/skills`) or the active project's `.pi/agent/skills` directory. In that case the skill name is inferred from the path and checked against `skills` policy even if no active prompt block listed the skill; direct user `/skill:<name>` requests are allowed to proceed for that requested skill.
### `special`

Reserved permission checks:

| Key                  | Description                              |
|----------------------|------------------------------------------|
| `doom_loop`          | Controls doom loop detection behavior    |
| `external_directory` | Coarse fallback for ask/allow/deny decisions on path-bearing built-in tools (`read`, `write`, `edit`, `find`, `grep`, `ls`) when they target paths outside the active working directory |
| `external_directory:<path>/*` | Resource-qualified external-directory rule for a specific normalized outside-worktree directory |

```jsonc
{
  "special": {
    "doom_loop": "deny",
    "external_directory": "ask",
    "external_directory:/home/alice/shared/*": "allow"
  }
}
```

`external_directory` is evaluated before the normal tool permission check. For example, `tools.read: "allow"` can permit ordinary reads while `special.external_directory: "ask"` still requires confirmation before reading `../outside.txt` or an absolute path outside `ctx.cwd`. Add `external_directory:<normalized-absolute-directory>/*` when a known outside directory should be allowed or denied without changing the coarse fallback. Optional-path search tools (`find`, `grep`, `ls`) skip this check when no `path` is provided because they default to the active working directory.

---

## Common Recipes

### Read-Only Mode

```jsonc
{
  "defaultPolicy": { "tools": "ask", "bash": "ask", "mcp": "ask", "skills": "ask", "special": "ask" },
  "tools": {
    "read": "allow",
    "grep": "allow",
    "find": "allow",
    "ls": "allow",
    "write": "deny",
    "edit": "deny"
  }
}
```

### Restricted Bash Surface

```jsonc
{
  "defaultPolicy": { "tools": "ask", "bash": "deny", "mcp": "ask", "skills": "ask", "special": "ask" },
  "bash": {
    "git *": "ask",
    "git status": "allow",
    "git diff": "allow",
    "git log *": "allow"
  }
}
```

### Safe Redirects Only

Allow commands that only redirect to `/dev/null` (plus fd-dup like `2>&1`), and prompt for anything that writes elsewhere. Note the catch-all `*` is declared **first** — last declared matching rule wins.

```jsonc
{
  "bashRedirect": {
    "*": "ask",
    "/dev/null*": "allow",
    "/dev/std*": "allow"
  }
}
```

### MCP Discovery Only

```jsonc
{
  "defaultPolicy": { "tools": "ask", "bash": "ask", "mcp": "ask", "skills": "ask", "special": "ask" },
  "mcp": {
    "*": "ask",
    "mcp_status": "allow",
    "mcp_list": "allow",
    "mcp_search": "allow",
    "mcp_describe": "allow"
  }
}
```

### Per-Agent Lockdown

In the global Pi agents directory (default: `~/.pi/agent/agents/reviewer.md`, respects `PI_CODING_AGENT_DIR`):

```yaml
---
permission:
  tools:
    write: deny
    edit: deny
  bash:
    "*": deny
---
```

---

## Technical Details

### Permission Prompt Summaries

When a tool permission resolves to `ask`, the prompt is designed to be readable enough for an informed approval decision:

- `bash` prompts show the command and matched bash pattern when available, plus the deciding redirect target when a `bashRedirect` rule forced the decision.
- `mcp` prompts show the derived MCP target and matched rule when available.
- Built-in file tools show concise summaries, such as the target path and edit/write line counts, instead of raw multiline JSON.
- Unknown or third-party extension tools show a bounded single-line JSON preview of the input so users are not asked to approve a blind tool name.

Example edit approval prompt:

```text
Current agent requested tool 'edit' for '.gitignore' (1 replacement: edit #1 replaces 5 lines with 2 lines). Allow this call?
```

### Subagent Permission Forwarding

When a delegated or routed subagent runs without direct UI access, `ask` permissions can still be enforced by forwarding the confirmation request through Pi session directories. The main interactive session polls for forwarded requests, shows the confirmation prompt, writes the response, and the subagent resumes once that decision is available.

This keeps `ask` policies usable even when the original permission check happens inside a non-UI execution context.

### Logging

When the extension prompts, denies, or forwards permission requests, it can append structured JSONL entries under:

```text
Default global logs directory: ~/.pi/agent/extensions/pi-permission-system/logs/
Actual global logs directory: $PI_CODING_AGENT_DIR/extensions/pi-permission-system/logs when PI_CODING_AGENT_DIR is set
Override logs directory: $PI_PERMISSION_SYSTEM_LOGS_DIR when set
```

- `pi-permission-system-debug.jsonl` — disabled by default; includes troubleshooting diagnostics and permission review/audit entries with responsible agent metadata, raw prompts, raw tool-call inputs, commands, targets, and decisions

### Architecture

```
index.ts                         → Root Pi entrypoint shim
src/
├── index.ts                     → Extension bootstrap, permission checks, readable prompts, debug review entries, reload handling, and subagent forwarding
├── before-agent-start-cache.ts  → Caches prompt/tool filtering state between before_agent_start runs
├── bash-filter.ts               → Bash command wildcard pattern matching
├── common.ts                    → Shared utilities (YAML parsing, type guards, etc.)
├── config-modal.ts              → `/permission-system` modal registration and settings UI wiring
├── extension-config.ts          → Extension-local config loading and default creation
├── logging.ts                   → File-only debug logging helpers
├── model-option-compatibility.ts → Guards unsupported provider/model options
├── permission-dialog.ts         → Interactive permission approval UI helpers
├── permission-forwarding.ts     → Subagent-to-parent permission forwarding utilities
├── permission-manager.ts        → Global/project policy loading, merging, and resolution with caching
├── skill-prompt-sanitizer.ts    → Skill prompt parsing, multi-block sanitization, and skill-read path matching
├── status.ts                    → Status line integration for runtime yolo state
├── system-prompt-sanitizer.ts   → Available-tools prompt filtering helpers
├── tool-registry.ts             → Registered tool name resolution
├── types.ts                     → TypeScript type definitions
├── wildcard-matcher.ts          → Shared wildcard pattern compilation and matching
├── yolo-mode.ts                 → Runtime yolo approval helpers
├── yolo-mode-api.ts             → Shared global runtime API for yolo toggling
└── zellij-modal.ts              → Reusable modal/settings UI components
tests/
├── permission-system.test.ts    → Core permission, layering, forwarding, and policy tests
├── config-modal.test.ts         → Modal command behavior tests
└── test-harness.ts              → Shared lightweight test helpers
schemas/
└── permissions.schema.json      → JSON Schema for policy validation
config/
└── config.example.json          → Starter global policy template
```

#### Module Organization

The extension uses a modular architecture with shared utilities:

| Module | Purpose |
|--------|---------|
| `common.ts` | Shared utilities: `toRecord()`, `getNonEmptyString()`, `isPermissionState()`, `parseSimpleYamlMap()`, `extractFrontmatter()` |
| `wildcard-matcher.ts` | Compile-once wildcard patterns with specificity sorting: `compileWildcardPatterns()`, `findCompiledWildcardMatch()` |
| `permission-manager.ts` | Policy resolution with file stamp caching for performance |
| `bash-filter.ts` | Uses shared wildcard matcher for bash command patterns |
| `skill-prompt-sanitizer.ts` | Parses all available skill prompt blocks, removes denied skills, and tracks visible skill paths for read protection |

#### Performance Optimizations

- **File stamp caching**: Configurations are cached with file modification timestamps to avoid redundant reads
- **Pre-compiled patterns**: Wildcard patterns are compiled to regex once and reused across permission checks
- **Resolved permissions caching**: Merged agent+global permissions are cached per-agent with invalidation on file changes

### Threat Model

**Goal:** Enforce policy at the host level, not the model level.

**What this stops:**
- Agent calling tools it shouldn't use (e.g., `write`, dangerous `bash`)
- Tool switching attempts (calling non-existent tool names)
- Accidental escalation via skill loading
- Unapproved path-bearing tool access outside the active working directory when `external_directory` is `ask` or `deny`

**Limitations:**
- If a dangerous action is possible via an allowed tool, policy must explicitly restrict it
- This is a permission decision layer, not a sandbox

### Schema Validation

Validate your config against the included schema:

```bash
npx --yes ajv-cli@5 validate \
  -s ./schemas/permissions.schema.json \
  -d ./pi-permissions.valid.json
```

**Editor tip:** Add `"$schema": "./schemas/permissions.schema.json"` to your config for autocomplete support.

---

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| Config not applied (everything asks) | File not found or parse error | Verify the global Pi policy file (default: `~/.pi/agent/pi-permissions.jsonc`, respects `PI_CODING_AGENT_DIR`); check the TUI warning for the parse location/message |
| Per-agent override not applied | Frontmatter parsing issue | Ensure `---` delimiters at file top; keep YAML simple; restart session |
| Tool blocked as unregistered | Unknown tool name | Use a registered `mcp` tool for server tools: `{ "tool": "server:tool" }` |
| `/skill:<name>` blocked | Deny policy or confirmation unavailable | Check merged `skills` policy (global/project/agent layers). Active agent context is optional in the main session; `ask` still requires UI or forwarded confirmation. |
| External file path blocked | `special.external_directory` is `ask` without UI or a matching rule resolves to `deny` | Keep file tools inside the active working directory, set an appropriate coarse fallback, or add a scoped rule such as `external_directory:/home/alice/shared/*`. |
| Permission prompt is too verbose | Generic extension tool input is large | Built-in file tools are summarized automatically; third-party tools are capped to a bounded one-line JSON preview. |

---

## Development

Runtime checks require Node.js 20+ and Bun 1.1+; the test suite runs through Bun.

```bash
npm run build              # Run TypeScript type checks
npm run lint               # Run local static checks
npm run validate:artifacts # Validate JSON/schema/example artifacts
npm run test               # Run Bun tests from ./tests
npm run check              # Run static, artifact, and test checks
```

---

## Related Pi Extensions

- [pi-multi-auth](https://github.com/MasuRii/pi-multi-auth) — Multi-provider credential management and quota-aware rotation
- [pi-tool-display](https://github.com/MasuRii/pi-tool-display) — Compact tool rendering and diff visualization
- [pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer) — RTK command rewriting and output compaction
- [pi-MUST-have-extension](https://github.com/MasuRii/pi-MUST-have-extension) — RFC 2119 keyword normalization for prompts

## License

[MIT](LICENSE)

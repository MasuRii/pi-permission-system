# pi-permission-system

Permission enforcement extension for the Pi coding agent.

This extension enforces **tool**, **bash**, **MCP**, **skill**, and a small set of **special** permission policies.
It is designed to reduce accidental or policy-violating actions by:

- hiding disallowed tools from the agent *before it starts* (reduces “try another tool” behavior), and
- blocking/asking/allowing at **tool call time** (the actual enforcement point).

> Global runtime policy file (JSON-with-comments):
>
> `~/.pi/agent/pi-permissions.jsonc`

![alt text](asset/pi-permission-system.png)

---

## Threat model / goal

**Goal:** Provide a centralized, deterministic permission gate for the Pi agent runtime so that *policy is enforced by the host*, not by the model.

**Threat model (what this is meant to stop):**

- The agent calling tools it should not use (e.g., `write`, dangerous `bash`, broad MCP actions).
- “Tool switching” attempts (agent tries a different tool name or a server tool directly).
- Accidental escalation via skill loading or reading skill files from disk.

**Non-goals / limitations:**

- If a dangerous action is possible using an allowed tool (e.g., destructive shell commands via allowed `bash`), policy must explicitly restrict that.
- This is not a sandbox; it is a permission decision layer.

---

## How it integrates with Pi

This extension integrates via Pi’s extension lifecycle hooks:

- `before_agent_start`
  - Filters the active tool list via `pi.setActiveTools(...)` based on the resolved permission policy.
  - Filters the `<available_skills> ... </available_skills>` section in the system prompt so skills with `deny` are removed.
- `tool_call`
  - Enforces permissions for every tool call.
  - When a permission is `ask`, it prompts the user via the UI confirmation dialog.
- `input`
  - Intercepts `/skill:<name>` requests and enforces the `skills` policy before the skill is loaded.

Additional enforcement behaviors:

- **Unknown/unregistered tools are blocked** before permission checks (prevents bypass via calling non-existent tool names).
- The delegation tool **`task` is restricted to the `orchestrator` agent**.

---

## Installation

### Local extension folder

Place this folder in one of:

- Global: `~/.pi/agent/extensions/pi-permission-system`
- Project: `.pi/extensions/pi-permission-system`

Pi auto-discovers these paths.

---

## Configuration

### Global policy file (required)

Runtime policy is loaded from:

- `~/.pi/agent/pi-permissions.jsonc`

Notes:

- The file is parsed as JSON after stripping `// ...` and `/* ... */` comments.
- Trailing commas are **not** supported (it still uses `JSON.parse` after comment stripping).
- If the file cannot be read or parsed, the extension falls back to an empty config with a default of **`ask`** for all categories.

### Per-agent overrides (frontmatter)

Per-agent overrides are loaded from the agent markdown file:

- `~/.pi/agent/agents/<agent>.md`

Add a YAML frontmatter block at the top of the agent file and include a `permission:` map.
Example:

```md
---
name: my-agent
permission:
  defaultPolicy:
    tools: ask
    bash: ask
    mcp: ask
    skills: ask
    special: ask

  # Recommended: configure permissions by section.
  tools:
    read: allow
    write: deny
    bash: ask

  # Alternative (equivalent): direct tool keys also work, but avoid duplicates.
  # read: allow
  # write: deny

  bash:
    git status: allow
    git *: ask

  mcp:
    mcp_status: allow
    # Prefer the underscore form in frontmatter (no ':' parsing edge cases):
    myServer_*: ask

  skills:
    "*": ask
---

# Agent prompt
...
```

**Precedence:** agent frontmatter overrides global config (shallow-merged per section).

**Frontmatter parser limitations:** the agent override parser is intentionally minimal (a simple YAML-ish map parser). Stick to:

- `key: value` scalars and nested maps via indentation
- `#` comments

Avoid advanced YAML features (arrays, multi-line scalars, anchors, etc.).

**Reload behavior:**

- Global config (`pi-permissions.jsonc`) is re-read during permission checks, so edits typically apply immediately.
- Agent frontmatter overrides are cached for some checks (notably tool exposure/mapping). If an override change does not appear to apply, restart the session.

### Config example

A starter template is provided at:

- `config/config.example.json`

---

## Policy reference

The policy file is a JSON object with these top-level keys:

- `defaultPolicy` (required)
- `tools` (built-in tools)
- `bash` (command patterns)
- `mcp` (MCP target patterns)
- `skills` (skill name patterns)
- `special` (reserved/special checks)

All permission states are one of:

- `allow`
- `deny`
- `ask` (requires UI confirmation)

### `defaultPolicy`

Sets defaults when no specific rule matches.

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

Controls built-in tools by exact name (no wildcard matching):

- `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`

Example:

```jsonc
{
  "tools": {
    "read": "allow",
    "write": "deny",
    "edit": "deny"
  }
}
```

**Bash nuance:** setting `tools.bash` affects the *default* decision for bash commands, but `bash` patterns (see below) can still provide command-level allow/deny/ask.

### `bash`

Command permissions are matched against the full command string using `*` wildcards.
Patterns are anchored (`^...$`) and matched by specificity:

1. fewer `*` wildcards wins
2. then longer literal text wins
3. then longer overall pattern wins

Example:

```jsonc
{
  "bash": {
    "git status": "allow",
    "git *": "ask",
    "rm -rf *": "deny"
  }
}
```

### `skills`

Matches skill names using `*` wildcards (same specificity approach as above).

```jsonc
{
  "skills": {
    "*": "ask",
    "dangerous-*": "deny"
  }
}
```

### `mcp`

MCP permissions match against a set of derived “targets” from the `mcp` tool input. You can write rules against:

- baseline operations: `mcp_status`, `mcp_list`, `mcp_search`, `mcp_describe`, `mcp_connect`
- the server name (e.g. `myServer`)
- server/tool combinations (e.g. `myServer:search`, `myServer_search`)
- generic categories like `mcp_call`

Example:

```jsonc
{
  "mcp": {
    "mcp_status": "allow",
    "mcp_list": "allow",
    "mcp_search": "allow",

    "myServer": "ask",
    "myServer:*": "ask",

    "dangerousServer": "deny"
  }
}
```

**Baseline auto-allow behavior:** when you allow *any* MCP rule (or set `defaultPolicy.mcp` to `allow`), baseline discovery targets like `mcp_status` may be auto-allowed to support normal MCP discovery flows.

### `special`

The schema includes these keys:

- `doom_loop`
- `external_directory`
- `tool_call_limit`

Only `doom_loop` and `external_directory` are recognized as “special permission names” by this extension’s permission manager.
`tool_call_limit` is present in the schema for forward compatibility and is **not enforced by this extension version**.

---

## Schema reference & validation

- Schema file (in this repo): `schemas/permissions.schema.json`

How to validate:

1. Ensure your config is valid JSON (remove comments if your validator does not support JSONC).
2. Use any JSON Schema validator against `schemas/permissions.schema.json`.

Example (Ajv CLI):

```bash
# Validate a comment-free copy of your config
npx --yes ajv-cli@5 validate \
  -s ./schemas/permissions.schema.json \
  -d ./pi-permissions.valid.json
```

Editor tip: you may add a `$schema` field to your config so editors can provide autocomplete/validation.

---

## Common recipes

### 1) Read-only by default (deny writes)

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

### 2) Allow only a small bash surface

```jsonc
{
  "defaultPolicy": { "tools": "ask", "bash": "deny", "mcp": "ask", "skills": "ask", "special": "ask" },
  "bash": {
    "git status": "allow",
    "git diff": "allow",
    "git *": "ask"
  }
}
```

### 3) Allow MCP discovery, ask on server calls

```jsonc
{
  "defaultPolicy": { "tools": "ask", "bash": "ask", "mcp": "ask", "skills": "ask", "special": "ask" },
  "mcp": {
    "mcp_status": "allow",
    "mcp_list": "allow",
    "mcp_search": "allow",
    "mcp_describe": "allow",

    "*": "ask"
  }
}
```

### 4) Tighten one agent only (frontmatter override)

In `~/.pi/agent/agents/reviewer.md`:

```md
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

## Troubleshooting

### “My config isn’t applied (everything still asks)”

- Confirm the file is at `~/.pi/agent/pi-permissions.jsonc`.
- Check for JSON parse errors (common causes: trailing commas, missing quotes).
- If parsing fails, the extension silently falls back to an empty config (defaults to `ask`).

### “My per-agent override isn’t applied”

- Confirm the file exists at `~/.pi/agent/agents/<agent>.md`.
- Ensure the frontmatter starts at the very top of the file and is delimited by `---`.
- Keep the `permission:` block simple (maps + scalars only).
- Restart the Pi session if you edited agent frontmatter during an active session (some override data is cached).

### “Tool was blocked as unregistered”

- The extension blocks unregistered tool names before permission checks.
- If you intended to call an MCP server tool directly, use the built-in `mcp` tool instead (e.g. `{ "tool": "server:tool" }`).

### “/skill:<name> is blocked”

- Skill loading requires a known active agent context and a non-`deny` `skills` policy.
- If you run headless (no UI), `ask` decisions may effectively behave like blocks because they cannot be confirmed.

---

## Development

```bash
npm run build
npm run lint
npm run test
npm run check
```

---

## Project layout

- `index.ts` - root Pi entrypoint shim
- `src/index.ts` - extension bootstrap + enforcement integration (`before_agent_start`, `tool_call`, `input`)
- `src/permission-manager.ts` - policy loading, merging, and permission resolution
- `src/bash-filter.ts` - bash wildcard matcher / specificity sorting
- `src/tool-registry.ts` - registered tool name resolution + pre-check
- `src/types.ts` - shared permission types
- `src/test.ts` - TypeScript test runner
- `schemas/permissions.schema.json` - permission config schema
- `config/config.example.json` - starter config template

---

## License

MIT

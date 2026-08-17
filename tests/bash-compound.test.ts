// Tests for compound bash command segmentation and permission combination.
// Run with: node --experimental-strip-types tests/bash-compound.test.ts
// (Segment-level golden tests live in tests/bash-lexer.test.ts.)
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTest } from "./test-harness.js";
import {
  combinePermissions,
  BashFilter,
} from "../src/bash-filter.js";
import { applyPatternApprovalState } from "../src/index.js";
import { PermissionManager } from "../src/permission-manager.js";
import { formatAskPrompt } from "../src/permission-prompts.js";
import { SessionApprovalStore } from "../src/session-approval-store.js";

// ===== combinePermissions tests =====

runTest("combine: all allow = allow", () => {
  assert.equal(combinePermissions(["allow", "allow"]), "allow");
});

runTest("combine: all ask = ask", () => {
  assert.equal(combinePermissions(["ask", "ask"]), "ask");
});

runTest("combine: allow + ask = ask", () => {
  assert.equal(combinePermissions(["allow", "ask"]), "ask");
});

runTest("combine: ask + allow = ask", () => {
  assert.equal(combinePermissions(["ask", "allow"]), "ask");
});

runTest("combine: any deny = deny (first)", () => {
  assert.equal(combinePermissions(["deny", "allow"]), "deny");
});

runTest("combine: any deny = deny (middle)", () => {
  assert.equal(combinePermissions(["allow", "deny", "ask"]), "deny");
});

runTest("combine: any deny = deny (last)", () => {
  assert.equal(combinePermissions(["allow", "ask", "deny"]), "deny");
});

runTest("combine: empty = ask (safe default)", () => {
  assert.equal(combinePermissions([]), "ask");
});

// ===== BashFilter compound command integration tests =====

runTest("BashFilter: compound command where second segment matches allow", () => {
  const filter = new BashFilter({ "git *": "allow", "bun *": "ask" }, "ask");
  // cd dir && bun test — 'bun test' matches "bun *" (ask), 'cd dir' is default (ask)
  // combine(ask, ask) = ask
  const result = filter.check("cd dir && bun test");
  assert.equal(result.state, "ask");
});

runTest("BashFilter: compound command where second segment matches pattern", () => {
  // Note: last-match-wins, so broad fallback "*" must come first
  const filter = new BashFilter({ "*": "ask", "bun * 2>&1": "allow" }, "ask");
  // 'cd dir' matches "*" (ask), 'bun test 2>&1' matches "bun * 2>&1" (allow)
  // combine(ask, allow) = ask
  const result = filter.check("cd dir && bun test 2>&1");
  assert.equal(result.state, "ask", "cd matches ask, bun matches allow → most restrictive is ask");
});

runTest("BashFilter: pipe splits both segments", () => {
  const filter = new BashFilter({ "cat *": "allow", "grep *": "ask" }, "ask");
  // 'cat file' matches "cat *" (allow), 'grep foo' matches "grep *" (ask)
  // combine(allow, ask) = ask
  const result = filter.check("cat file | grep foo");
  assert.equal(result.state, "ask");
});

runTest("BashFilter: pipe with deny in any segment blocks", () => {
  // Note: last-match-wins, so broad fallback "*" must come first
  const filter = new BashFilter({ "*": "ask", "cat *": "allow", "grep secret*": "deny" }, "ask");
  // 'cat file' matches "cat *" (allow), 'grep secret_file' matches "grep secret*" (deny)
  // combine(allow, deny) = deny
  const result = filter.check("cat file | grep secret_file");
  assert.equal(result.state, "deny");
});

runTest("BashFilter: quoted operators not split", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "deny");
  // The entire string is one segment because && is inside quotes
  const result = filter.check("echo 'a && b'");
  assert.equal(result.state, "allow", "single segment matches echo *");
});

runTest("BashFilter: three-segment compound, middle is deny", () => {
  // Note: last-match-wins, so broad fallback "*" must come first
  const filter = new BashFilter({ "*": "ask", "echo *": "allow", "rm *": "deny", "ls": "allow" }, "ask");
  const result = filter.check("echo start && rm -rf / && ls");
  assert.equal(result.state, "deny", "rm segment matches deny → whole command denied");
});

 // ===== Opaque segment tests (unparseable constructs → always "ask") =====

 runTest("BashFilter: opaque segment ($( ... ) subshell) resolves to ask despite matching pattern", () => {
   // 'bun $(weird' contains an unknown token → opaque → skips pattern matching.
   // The scaffolding splitter would have pattern-matched the whole text; the
   // tokenizer makes it opaque → always ask (intentional behavior change).
   const filter = new BashFilter({ "bun *": "allow" }, "ask");
   const result = filter.check("bun $(weird");
   assert.equal(result.state, "ask", "opaque segment never receives a pattern's permission");
 });

 runTest("BashFilter: opaque segment with default deny still resolves to ask", () => {
   // User decision: opaque ALWAYS asks — never the default state. With an
   // allow default, inheriting it would let unparseable commands slip through
   // the user's deny/ask rules; with a deny default, asking still lets the
   // user decide.
   const filter = new BashFilter({ "bun *": "allow" }, "deny");
   const result = filter.check("bun $(weird");
   assert.equal(result.state, "ask");
 });

 runTest("BashFilter: opaque backtick segment always resolves to ask", () => {
   const filter = new BashFilter({ "echo *": "allow" }, "ask");
   const result = filter.check("echo `ls`");
   assert.equal(result.state, "ask");
 });

runTest("BashFilter: opaque segment combined with denied segment stays deny", () => {
  const filter = new BashFilter({ "rm *": "deny" }, "ask");
  const result = filter.check("rm -rf /tmp/x && bun $(weird");
  assert.equal(result.state, "deny");
});

runTest("BashFilter: empty command resolves to default state", () => {
  const filter = new BashFilter({ "*": "allow" }, "ask");
  assert.equal(filter.check("").state, "ask");
  assert.equal(filter.check("   ").state, "ask");
  const denyFilter = new BashFilter({ "*": "allow" }, "deny");
  assert.equal(denyFilter.check("").state, "deny");
});

// ===== Opaque reporting: prompts must explain, not mislead =====

runTest("BashFilter: hasOpaqueSegments flag is set only for opaque commands", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "ask");
  assert.equal(filter.check("echo $(whoami)").hasOpaqueSegments, true);
  assert.equal(filter.check("echo `ls`").hasOpaqueSegments, true);
  assert.equal(filter.check("echo hi").hasOpaqueSegments, false);
  assert.equal(filter.check("").hasOpaqueSegments, false);
});

runTest("opaque e2e: prompt explains unparseable constructs and shows no fake pattern", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-opaque-"));
  const agentsDir = join(baseDir, "agents");
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    globalConfigPath,
    `${JSON.stringify({
      defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
      tools: {},
      bash: { "echo *": "allow" },
      mcp: {},
      skills: {},
      special: {},
    }, null, 2)}\n`,
    "utf8",
  );

  try {
    const manager = new PermissionManager({ globalConfigPath, agentsDir });
    const result = manager.checkPermission("bash", { command: "echo $(whoami)" });
    assert.equal(result.state, "ask");
    assert.equal(result.hasOpaqueSegments, true);
    assert.equal(result.matchedPattern, undefined);

    const prompt = formatAskPrompt(result, undefined, { command: "echo $(whoami)" });
    assert.ok(prompt.includes("unparseable"), `prompt should explain opacity: ${prompt}`);
    assert.ok(!prompt.includes("(matched"), `prompt must not show a fake pattern: ${prompt}`);

    const clean = manager.checkPermission("bash", { command: "echo hi" });
    assert.equal(clean.hasOpaqueSegments, false);
    const cleanPrompt = formatAskPrompt(clean, undefined, { command: "echo hi" });
    assert.ok(!cleanPrompt.includes("unparseable"), cleanPrompt);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ===== applyPatternApprovalState: the synthetic "*" rule must not leak =====

runTest("approval re-eval: synthetic * pattern does not leak into matchedPattern", () => {
  const store = new SessionApprovalStore();
  const result = applyPatternApprovalState(
    { toolName: "bash", state: "ask", command: "echo $(whoami)", source: "bash" },
    { command: "echo $(whoami)" },
    store,
  );
  assert.equal(result.state, "ask");
  assert.equal(result.matchedPattern, undefined, "the synthetic * fallback is not a real config rule");
});

runTest("approval re-eval: real matchedPattern is preserved", () => {
  const store = new SessionApprovalStore();
  const result = applyPatternApprovalState(
    {
      toolName: "bash",
      state: "ask",
      command: "git commit -m x",
      matchedPattern: "git *commit*",
      source: "bash",
    },
    { command: "git commit -m x" },
    store,
  );
  assert.equal(result.state, "ask");
  assert.equal(result.matchedPattern, "git *commit*");
});

runTest("approval re-eval: session allow-always still upgrades ask to allow", () => {
  const store = new SessionApprovalStore();
  store.approveAlways("bash", "echo hi");
  const result = applyPatternApprovalState(
    { toolName: "bash", state: "ask", command: "echo hi", source: "bash" },
    { command: "echo hi" },
    store,
  );
  assert.equal(result.state, "allow");
});

console.log("Bash compound command test suite complete.");

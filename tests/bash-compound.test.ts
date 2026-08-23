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
import { formatAskPrompt, formatDenyReason } from "../src/permission-prompts.js";
import { SessionApprovalStore } from "../src/session-approval-store.js";
import type { PermissionCheckResult } from "../src/types.js";

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
    assert.deepEqual(result.bashReasons, [{ kind: "opaque", segmentIndex: 1 }]);

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

runTest("approval re-eval: non-bash matchedPattern is preserved", () => {
  const store = new SessionApprovalStore();
  const result = applyPatternApprovalState(
    {
      toolName: "mcp",
      state: "ask",
      target: "server:tool",
      matchedPattern: "server:*",
      source: "mcp",
    },
    { tool: "server:tool" },
    store,
  );
  assert.equal(result.state, "ask");
  assert.equal(result.matchedPattern, "server:*");
});

runTest("approval re-eval: bash results never carry matchedPattern (bashReasons report instead)", () => {
  const store = new SessionApprovalStore();
  const result = applyPatternApprovalState(
    {
      toolName: "bash",
      state: "ask",
      command: "git commit -m x",
      source: "bash",
    },
    { command: "git commit -m x" },
    store,
  );
  assert.equal(result.state, "ask");
  assert.equal(result.matchedPattern, undefined, "bash reporting uses bashReasons, not matchedPattern");
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

// ===== Reason reporting: prompts show every decision-affecting match =====

function toCheckResult(result: ReturnType<BashFilter["check"]>): PermissionCheckResult {
  return {
    toolName: "bash",
    state: result.state,
    command: result.command,
    bashReasons: result.reasons,
    bashSegmentCount: result.segmentCount,
    hasOpaqueSegments: result.hasOpaqueSegments,
    source: "bash",
  };
}

runTest("prompt: single-segment redirect reason is labeled bashRedirect, no segment prefix", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "ask", { "*": "ask" });
  const result = toCheckResult(filter.check("echo hi > /tmp/out.txt"));
  const prompt = formatAskPrompt(result, undefined, { command: result.command });
  assert.ok(prompt.includes("redirect to '/tmp/out.txt' matched bashRedirect '*'"), prompt);
  assert.ok(!prompt.includes("segment 1"), `single-segment prompts omit the prefix: ${prompt}`);
});

runTest("prompt: compound shows a numbered reason per deciding segment", () => {
  const filter = new BashFilter({ "git *commit*": "ask", "echo *": "allow" }, "ask", { "*": "ask" });
  const result = toCheckResult(filter.check("git commit -m x && echo hi > /tmp/out.txt"));
  const prompt = formatAskPrompt(result, undefined, { command: result.command });
  assert.ok(prompt.includes("segment 1 matched 'git *commit*'"), prompt);
  assert.ok(prompt.includes("segment 2 redirect to '/tmp/out.txt' matched bashRedirect '*'"), prompt);
});

runTest("prompt: allowed segments do not produce reasons", () => {
  const filter = new BashFilter({ "cd *": "allow", "git *commit*": "ask" }, "ask");
  const result = toCheckResult(filter.check("cd x && git commit -m y"));
  assert.equal(result.state, "ask");
  assert.deepEqual(result.bashReasons, [{ kind: "command", segmentIndex: 2, pattern: "git *commit*" }]);
  const prompt = formatAskPrompt(result, undefined, { command: result.command });
  assert.ok(prompt.includes("segment 2 matched 'git *commit*'"), prompt);
  assert.ok(!prompt.includes("segment 1"), `allow segment 1 must not be reported: ${prompt}`);
});

runTest("prompt: no-match segment reports the default state", () => {
  const filter = new BashFilter({}, "ask");
  const result = toCheckResult(filter.check("weirdcmd foo"));
  assert.equal(result.state, "ask");
  assert.deepEqual(result.bashReasons, [{ kind: "default", segmentIndex: 1 }]);
  const prompt = formatAskPrompt(result, undefined, { command: result.command });
  assert.ok(prompt.includes("no matching rule (default: ask)"), prompt);
});

runTest("prompt: opaque segment reason explains itself, no fake pattern", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "ask");
  const result = toCheckResult(filter.check("echo $(whoami)"));
  const prompt = formatAskPrompt(result, undefined, { command: result.command });
  assert.ok(prompt.includes("contains unparseable constructs — always requires approval"), prompt);
  assert.ok(!prompt.includes("matched '"), prompt);
});

runTest("deny reason: shows the deciding segment and rule", () => {
  const filter = new BashFilter({ "rm *": "deny" }, "ask", { "*": "ask" });
  const result = toCheckResult(filter.check("echo ok && rm -rf /tmp/x > /tmp/log"));
  assert.equal(result.state, "deny");
  assert.deepEqual(result.bashReasons, [{ kind: "command", segmentIndex: 2, pattern: "rm *" }]);
  const reason = formatDenyReason(result, undefined);
  assert.ok(reason.includes("segment 2 matched 'rm *'"), reason);
  assert.ok(reason.includes("Hard stop"), reason);
});

// ===== Control-flow structures (Phase 6) =====

runTest("cf: rules apply to commands inside if/then/fi", () => {
  const filter = new BashFilter({ "true": "allow", "rm *": "allow" }, "ask");
  const result = filter.check("if true; then rm y; fi");
  assert.equal(result.state, "allow", "condition + branch both match allow rules");
});

runTest("cf: unmatched condition forces the default state", () => {
  const filter = new BashFilter({ "rm *": "allow" }, "ask");
  const result = filter.check("if true; then rm y; fi");
  assert.equal(result.state, "ask", "condition 'true' matches no rule → default ask");
  assert.deepEqual(result.reasons, [{ kind: "default", segmentIndex: 1 }]);
});

runTest("cf: deny rule is not evadable by wrapping the command in if", () => {
  const filter = new BashFilter({ "true": "allow", "rm *": "deny" }, "ask");
  const result = filter.check("if true; then rm -rf /tmp/x; fi");
  assert.equal(result.state, "deny", "the branch command is a real segment and matches the deny rule");
});

runTest("cf: while loop — condition and body are both evaluated", () => {
  const filter = new BashFilter({ "pgrep *": "allow", "kill *": "deny" }, "ask");
  const result = filter.check("while pgrep foo; do kill 12345; done");
  assert.equal(result.state, "deny", "body command matches deny even inside a loop");
});

runTest("cf: for loop — only the body is evaluated, not the word list", () => {
  const filter = new BashFilter({ "rm *": "allow" }, "ask");
  const result = filter.check("for f in a b c; do rm $f; done");
  assert.equal(result.state, "allow", "list words are data; the body matches allow");
  assert.equal(result.segmentCount, 1);
});

runTest("cf: malformed control flow → opaque → ask despite catch-all allow", () => {
  const filter = new BashFilter({ "*": "allow" }, "allow");
  const result = filter.check("if a; then b");
  assert.equal(result.state, "ask", "missing fi → whole command opaque → always ask");
  assert.ok(result.hasOpaqueSegments);
});

runTest("cf: redirect policy applies inside control structures", () => {
  const filter = new BashFilter({ "true": "allow" }, "allow", { "*": "ask", "/dev/null*": "allow" });
  const result = filter.check("if true; then echo hi > /tmp/out.txt; fi");
  assert.equal(result.state, "ask", "redirect target matches * → ask inside the then branch");
  assert.deepEqual(result.reasons, [
    { kind: "redirect", segmentIndex: 2, target: "/tmp/out.txt", pattern: "*" },
  ]);
});

runTest("prompt: if/then/fi shows a numbered reason per deciding segment", () => {
  const filter = new BashFilter({}, "ask");
  const result = toCheckResult(filter.check("if true; then echo hi; fi"));
  assert.equal(result.state, "ask");
  const prompt = formatAskPrompt(result, undefined, { command: result.command });
  assert.ok(prompt.includes("segment 1 no matching rule (default: ask)"), prompt);
  assert.ok(prompt.includes("segment 2 no matching rule (default: ask)"), prompt);
});

runTest("prompt: opaque control flow explains itself", () => {
  const filter = new BashFilter({ "*": "allow" }, "allow");
  const result = toCheckResult(filter.check("if a; then b"));
  const prompt = formatAskPrompt(result, undefined, { command: result.command });
  assert.ok(prompt.includes("contains unparseable constructs — always requires approval"), prompt);
});

console.log("Bash compound command test suite complete.");

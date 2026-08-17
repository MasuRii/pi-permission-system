// ===========================================================================
// Bash redirect-target policy (bashRedirect config section) tests
//
// Semantics under test:
//   - Only OUTPUT redirects are evaluated (>, >>, &>, <>): they can write
//     files. fd-dup (2>&1) is safe by construction; input redirection (<)
//     never writes files. Both are exempt.
//   - When the bashRedirect section is configured, each output-redirect
//     target is matched against redirect patterns (same matcher as bash
//     command patterns — last-declared pattern wins, so broad fallbacks are
//     declared FIRST). A redirect state more restrictive than the segment's
//     command state wins. Unmatched targets resolve to the default bash
//     state.
//   - When the section is absent/empty, redirects do not affect the decision
//     (backward compatible).
 //   - Opaque segments skip ALL pattern matching (command and redirect) and
 //     always resolve to "ask" (never the default state).
// ===========================================================================

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { BashFilter, normalizeRedirectTarget } from "../src/bash-filter.js";
import { PermissionManager } from "../src/permission-manager.js";
import type { GlobalPermissionConfig } from "../src/types.js";
import { runTest } from "./test-harness.js";

// ===========================================================================
// Section 1: BashFilter — redirect policy semantics
// ===========================================================================

runTest("redirect: fd-dup (2>&1) is exempt even when all targets are ask", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "ask", { "*": "ask" });
  assert.equal(filter.check("echo hi 2>&1").state, "allow");
});

runTest("redirect: user's live case — bun ... 2>&1 stays allow under a strict redirect policy", () => {
  const filter = new BashFilter(
    { "cd *": "allow", "bun * 2>&1*": "allow" },
    "ask",
    { "*": "ask" },
  );
  assert.equal(filter.check("cd pi-permission-system && bun tests/foo.test.ts 2>&1").state, "allow");
});

runTest("redirect: output to /dev/null allowed by target pattern", () => {
  const filter = new BashFilter(
    { "echo *": "allow" },
    "ask",
    { "*": "ask", "/dev/null*": "allow" },
  );
  assert.equal(filter.check("echo hi > /dev/null").state, "allow");
});

runTest("redirect: unsafe output target forces ask despite allowed command", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "ask", { "*": "ask" });
  const result = filter.check("echo hi > /tmp/out.txt");
  assert.equal(result.state, "ask");
  assert.deepEqual(result.reasons, [{ kind: "redirect", segmentIndex: 1, target: "/tmp/out.txt", pattern: "*" }]);
});

runTest("redirect: mixed safe + unsafe redirects force ask", () => {
  const filter = new BashFilter(
    { "echo *": "allow" },
    "ask",
    { "*": "ask", "/dev/null*": "allow" },
  );
  assert.equal(filter.check("echo hi > /dev/null 2> /tmp/err.txt").state, "ask");
});

runTest("redirect: input redirection (<) is never evaluated", () => {
  const filter = new BashFilter({ "cat *": "allow" }, "ask", { "*": "ask" });
  assert.equal(filter.check("cat < /etc/passwd").state, "allow");
});

runTest("redirect: append (>>) is evaluated", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "ask", { "*": "ask" });
  assert.equal(filter.check("echo hi >> /tmp/log").state, "ask");
});

runTest("redirect: &> is evaluated", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "ask", { "*": "ask" });
  assert.equal(filter.check("echo hi &> /tmp/out").state, "ask");
});

runTest("redirect: <> (read-write) is evaluated", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "ask", { "*": "ask" });
  assert.equal(filter.check("echo hi <> /tmp/f").state, "ask");
});

runTest("redirect: no bashRedirect section — redirects do not affect the decision", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "ask");
  assert.equal(filter.check("echo hi > /tmp/out").state, "allow");
});

runTest("redirect: configured section, unmatched target resolves to default state", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "ask", { "other*": "allow" });
  assert.equal(filter.check("echo hi > /tmp/out").state, "ask");
});

runTest("redirect: deny target beats allowed command", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "ask", { "*": "deny" });
  assert.equal(filter.check("echo hi > /tmp/out").state, "deny");
});

runTest("redirect: compound — second segment's unsafe redirect forces ask", () => {
  const filter = new BashFilter(
    { "echo *": "allow", "cat *": "allow" },
    "ask",
    { "*": "ask", "/dev/null*": "allow" },
  );
  assert.equal(filter.check("echo ok > /dev/null && cat x > /tmp/out").state, "ask");
});

runTest("redirect: redirect reason reported when the redirect decided", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "ask", { "*": "ask" });
  const result = filter.check("echo hi > /tmp/out.txt");
  assert.deepEqual(result.reasons, [{ kind: "redirect", segmentIndex: 1, target: "/tmp/out.txt", pattern: "*" }]);
});

runTest("redirect: no redirect reason when the command state already decided", () => {
  const filter = new BashFilter({ "rm *": "deny" }, "ask", { "*": "ask" });
  const result = filter.check("rm -rf /tmp/x > /tmp/log");
  assert.equal(result.state, "deny");
  // The deny comes from the command rule; the ask redirect is less
  // restrictive and does not contribute a reason.
  assert.deepEqual(result.reasons, [{ kind: "command", segmentIndex: 1, pattern: "rm *" }]);
});

runTest("redirect: quoted target is matched by its unquoted value", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "ask", { "*": "ask" });
  const result = filter.check('echo hi > "/tmp/my out.txt"');
  assert.equal(result.state, "ask");
  assert.deepEqual(result.reasons, [{ kind: "redirect", segmentIndex: 1, target: "/tmp/my out.txt", pattern: "*" }]);
});

 runTest("redirect: opaque segment skips redirect policy and always resolves to ask", () => {
   const filter = new BashFilter({ "echo *": "allow" }, "ask", { "*": "deny" });
   assert.equal(filter.check("echo $(hi) > /tmp/out").state, "ask");
 });

runTest("redirect: opaque segment with default deny still resolves to ask", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "deny", { "*": "deny" });
  assert.equal(filter.check("echo $(hi) > /tmp/out").state, "ask");
});

// ===========================================================================
// Section 1b: redirect-target normalization
//
//   - Absolute targets are lexically normalized before matching, so
//     `/tmp/../etc/foo` cannot evade a rule for `/etc/*`, and an allow rule
//     for `/tmp/*` cannot leak through it to `/etc/foo`.
//   - `~` / `~/...` expand to the home directory — in command targets AND in
//     config patterns (convenience).
//   - Relative targets are left as-is (cwd at redirect time is unreliable in
//     compound commands) and fall through to the default state.
// ===========================================================================

runTest("normalizeRedirectTarget: resolves .. and duplicate slashes in absolute paths", () => {
  assert.equal(normalizeRedirectTarget("/tmp/../etc/foo"), "/etc/foo");
  assert.equal(normalizeRedirectTarget("//tmp//x"), "/tmp/x");
  assert.equal(normalizeRedirectTarget("/a/b/./c"), "/a/b/c");
  assert.equal(normalizeRedirectTarget("/dev/null"), "/dev/null");
});

runTest("normalizeRedirectTarget: expands ~ targets to the home directory", () => {
  assert.equal(normalizeRedirectTarget("~/x/../y"), join(homedir(), "y"));
  assert.equal(normalizeRedirectTarget("~"), homedir());
});

runTest("normalizeRedirectTarget: leaves relative targets alone", () => {
  assert.equal(normalizeRedirectTarget("out.txt"), "out.txt");
  assert.equal(normalizeRedirectTarget("../sibling/out.txt"), "../sibling/out.txt");
});

runTest("redirect: /tmp/* allow rule cannot leak to /etc via .. in the target", () => {
  const filter = new BashFilter(
    { "echo *": "allow" },
    "ask",
    { "/tmp/*": "allow", "*": "ask" },
  );
  const result = filter.check("echo hi > /tmp/../etc/foo");
  assert.equal(result.state, "ask");
  assert.deepEqual(result.reasons, [{ kind: "redirect", segmentIndex: 1, target: "/etc/foo", pattern: "*" }]);
});

runTest("redirect: /etc/* deny rule catches ..-spelled targets", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "ask", { "/etc/*": "deny" });
  const result = filter.check("echo hi > /tmp/../etc/foo");
  assert.equal(result.state, "deny");
  assert.deepEqual(result.reasons, [{ kind: "redirect", segmentIndex: 1, target: "/etc/foo", pattern: "/etc/*" }]);
});

runTest("redirect: ~ in the command target matches an absolute home pattern", () => {
  const filter = new BashFilter(
    { "echo *": "allow" },
    "ask",
    { [join(homedir(), "secrets/*")]: "deny" },
  );
  assert.equal(filter.check("echo hi > ~/secrets/notes.txt").state, "deny");
});

runTest("redirect: ~ in the config pattern matches a ~ command target", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "ask", { "~/secrets/*": "deny" });
  const result = filter.check("echo hi > ~/secrets/notes.txt");
  assert.equal(result.state, "deny");
  // The reported pattern is the expanded form: ~ is expanded before
  // compilation, so the reason shows the absolute rule (matching the
  // expanded target shown alongside it).
  assert.deepEqual(result.reasons, [{ kind: "redirect", segmentIndex: 1, target: join(homedir(), "secrets/notes.txt"), pattern: join(homedir(), "secrets/*") }]);
});

runTest("redirect: relative targets match literal rules and fall through otherwise", () => {
  const filter = new BashFilter({ "echo *": "allow" }, "ask", { "out.txt": "deny" });
  assert.equal(filter.check("echo hi > out.txt").state, "deny");

  const filter2 = new BashFilter({ "echo *": "allow" }, "ask", { "/tmp/*": "ask" });
  // out.txt matches no redirect pattern -> default state (ask)
  assert.equal(filter2.check("echo hi > out.txt").state, "ask");
});

// ===========================================================================
// Section 2: PermissionManager — config plumbing (bashRedirect section)
// ===========================================================================

function createManager(config: GlobalPermissionConfig, projectConfig?: GlobalPermissionConfig) {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-redirect-"));
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  const projectConfigPath = join(baseDir, "project-permissions.jsonc");
  const agentsDir = join(baseDir, "agents");

  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(globalConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  if (projectConfig) {
    writeFileSync(projectConfigPath, `${JSON.stringify(projectConfig, null, 2)}\n`, "utf8");
  }

  const manager = new PermissionManager({
    globalConfigPath,
    agentsDir,
    projectGlobalConfigPath: projectConfig ? projectConfigPath : undefined,
  });

  return {
    manager,
    cleanup: (): void => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

function baseConfig(overrides: Partial<GlobalPermissionConfig> = {}): GlobalPermissionConfig {
  return {
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask", special: "ask" },
    tools: {},
    bash: {},
    mcp: {},
    skills: {},
    special: {},
    ...overrides,
  };
}

runTest("redirect e2e: unsafe output target forces ask and reports the target", () => {
  const { manager, cleanup } = createManager(
    baseConfig({
      bash: { "echo *": "allow" },
      bashRedirect: { "*": "ask", "/dev/null*": "allow" },
    }),
  );
  try {
    const result = manager.checkPermission("bash", { command: "echo hi > /tmp/out.txt" });
    assert.equal(result.state, "ask");
    assert.deepEqual(result.bashReasons, [{ kind: "redirect", segmentIndex: 1, target: "/tmp/out.txt", pattern: "*" }]);
    assert.equal(result.source, "bash");
  } finally {
    cleanup();
  }
});

runTest("redirect e2e: /dev/null target allowed end to end", () => {
  const { manager, cleanup } = createManager(
    baseConfig({
      bash: { "echo *": "allow" },
      bashRedirect: { "*": "ask", "/dev/null*": "allow" },
    }),
  );
  try {
    const result = manager.checkPermission("bash", { command: "echo hi > /dev/null" });
    assert.equal(result.state, "allow");
    // Both the command rule and the redirect rule resolve to allow; both
    // share the segment's final state, so both are reported.
    assert.deepEqual(result.bashReasons, [
      { kind: "command", segmentIndex: 1, pattern: "echo *" },
      { kind: "redirect", segmentIndex: 1, target: "/dev/null", pattern: "/dev/null*" },
    ]);
  } finally {
    cleanup();
  }
});

runTest("redirect e2e: no bashRedirect section — behavior unchanged", () => {
  const { manager, cleanup } = createManager(
    baseConfig({ bash: { "echo *": "allow" } }),
  );
  try {
    const result = manager.checkPermission("bash", { command: "echo hi > /tmp/out" });
    assert.equal(result.state, "allow");
  } finally {
    cleanup();
  }
});

runTest("redirect e2e: project config overrides global bashRedirect", () => {
  const { manager, cleanup } = createManager(
    baseConfig({
      bash: { "echo *": "allow" },
      bashRedirect: { "*": "ask" },
    }),
    baseConfig({ bashRedirect: { "*": "allow" } }),
  );
  try {
    const result = manager.checkPermission("bash", { command: "echo hi > /tmp/out" });
    assert.equal(result.state, "allow");
  } finally {
    cleanup();
  }
});

runTest("redirect e2e: fd-dup stays allow under strict redirect policy", () => {
  const { manager, cleanup } = createManager(
    baseConfig({
      bash: { "cd *": "allow", "bun * 2>&1*": "allow" },
      bashRedirect: { "*": "ask" },
    }),
  );
  try {
    const result = manager.checkPermission(
      "bash",
      { command: "cd pi-permission-system && bun tests/foo.test.ts 2>&1" },
    );
    assert.equal(result.state, "allow");
  } finally {
    cleanup();
  }
});

runTest("redirect e2e: ~ in the config pattern is expanded for command targets", () => {
  const { manager, cleanup } = createManager(
    baseConfig({
      bash: { "echo *": "allow" },
      bashRedirect: { "*": "ask", "~/secrets/*": "deny" },
    }),
  );
  try {
    const result = manager.checkPermission("bash", { command: "echo hi > ~/secrets/notes.txt" });
    assert.equal(result.state, "deny");
    assert.deepEqual(result.bashReasons, [{ kind: "redirect", segmentIndex: 1, target: join(homedir(), "secrets/notes.txt"), pattern: join(homedir(), "secrets/*") }]);
  } finally {
    cleanup();
  }
});

console.log("Bash redirect policy test suite complete.");

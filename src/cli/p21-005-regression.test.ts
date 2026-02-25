/**
 * P21-005: Regression/snapshot tests for CLI help text, outcome summaries,
 * and config precedence outputs.
 *
 * These tests lock down the stable textual interface surfaces changed in
 * P21-001 through P21-004 to prevent silent regressions from future CLI
 * refactors.  Volatile values (absolute paths) are checked with toContain
 * rather than full-string snapshots to keep assertions stable across
 * environments while still pinning every key token.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TestSandbox, runIxado } from "./test-helpers";

// ── 1. Global help output ────────────────────────────────────────────────────

describe("P21-005 global help text", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((s) => s.cleanup()));
    sandboxes.length = 0;
  });

  test("ixado help: header, usage section, and footer are present", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-help-global-");
    sandboxes.push(sandbox);

    const result = runIxado(["help"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("IxADO CLI");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain(
      "Run 'ixado <command> help' for subcommand details.",
    );
  });

  test("ixado help: all top-level command entries are listed", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-help-entries-");
    sandboxes.push(sandbox);

    const result = runIxado(["help"], sandbox);

    expect(result.exitCode).toBe(0);
    const out = result.stdout;

    for (const entry of [
      "status",
      "init",
      "list",
      "switch",
      "onboard",
      "task list",
      "task create",
      "task start",
      "task retry",
      "task logs",
      "task reset",
      "phase create",
      "phase active",
      "phase run",
      "config",
      "web start",
      "web stop",
      "web serve",
      "help",
    ]) {
      expect(out).toContain(entry);
    }
  });

  test("ixado help: all command descriptions are stable", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-help-descs-");
    sandboxes.push(sandbox);

    const result = runIxado(["help"], sandbox);

    expect(result.exitCode).toBe(0);
    const out = result.stdout;

    for (const desc of [
      "Show project status and running agents",
      "Register current directory as project in global config",
      "Show all registered projects",
      "Switch active project context",
      "Configure global CLI settings",
      "List tasks in active phase with numbers",
      "Create task in active phase",
      "Start active-phase task",
      "Retry FAILED task with same assignee/session",
      "Show logs/result for task in active phase",
      "Reset FAILED task to TODO and hard-reset repo",
      "Create phase and set it active",
      "Set active phase",
      "Run TODO/CI_FIX tasks in active phase sequentially",
      "Start local web control center in background",
      "Stop local web control center",
      "Run web control center in foreground",
    ]) {
      expect(out).toContain(desc);
    }
  });

  test("ixado help: usages include argument placeholders", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-help-usages-");
    sandboxes.push(sandbox);

    const result = runIxado(["help"], sandbox);

    expect(result.exitCode).toBe(0);
    const out = result.stdout;

    // Key argument placeholders that must appear verbatim in the help table.
    expect(out).toContain("switch <project-name>");
    expect(out).toContain("task create <title> <description> [assignee]");
    expect(out).toContain("task start <taskNumber> [assignee]");
    expect(out).toContain("task retry <taskNumber>");
    expect(out).toContain("task logs <taskNumber>");
    expect(out).toContain("task reset <taskNumber>");
    expect(out).toContain("phase create <name> <branchName>");
    expect(out).toContain("phase active <phaseNumber|phaseId>");
    expect(out).toContain("phase run [auto|manual] [countdownSeconds>=0]");
    expect(out).toContain("web start [port]");
    expect(out).toContain("web serve [port]");
  });

  test("ixado --help: same output as ixado help", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-help-flag-");
    sandboxes.push(sandbox);

    const helpResult = runIxado(["help"], sandbox);
    const flagResult = runIxado(["--help"], sandbox);

    expect(flagResult.exitCode).toBe(0);
    expect(flagResult.stdout).toBe(helpResult.stdout);
  });
});

// ── 2. Per-group help output ─────────────────────────────────────────────────

describe("P21-005 per-group help text", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((s) => s.cleanup()));
    sandboxes.length = 0;
  });

  test("ixado task help: header and all subcommand usages", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-help-task-");
    sandboxes.push(sandbox);

    const result = runIxado(["task", "help"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    expect(out).toContain("Task commands:");
    expect(out).toContain("ixado task list");
    expect(out).toContain("ixado task create <title> <description> [assignee]");
    expect(out).toContain("ixado task start <taskNumber> [assignee]");
    expect(out).toContain("ixado task retry <taskNumber>");
    expect(out).toContain("ixado task logs <taskNumber>");
    expect(out).toContain("ixado task reset <taskNumber>");
  });

  test("ixado task help: all descriptions are stable", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-help-task-d-");
    sandboxes.push(sandbox);

    const result = runIxado(["task", "help"], sandbox);

    expect(result.exitCode).toBe(0);
    const out = result.stdout;
    expect(out).toContain("List tasks in active phase with numbers");
    expect(out).toContain("Create task in active phase");
    expect(out).toContain("Start active-phase task");
    expect(out).toContain("Retry FAILED task with same assignee/session");
    expect(out).toContain("Show logs/result for task in active phase");
    expect(out).toContain("Reset FAILED task to TODO and hard-reset repo");
  });

  test("ixado phase help: header and all subcommand usages", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-help-phase-");
    sandboxes.push(sandbox);

    const result = runIxado(["phase", "help"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    expect(out).toContain("Phase commands:");
    expect(out).toContain("ixado phase create <name> <branchName>");
    expect(out).toContain("ixado phase active <phaseNumber|phaseId>");
    expect(out).toContain(
      "ixado phase run [auto|manual] [countdownSeconds>=0]",
    );
  });

  test("ixado phase help: all descriptions are stable", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-help-phase-d-");
    sandboxes.push(sandbox);

    const result = runIxado(["phase", "help"], sandbox);

    expect(result.exitCode).toBe(0);
    const out = result.stdout;
    expect(out).toContain("Create phase and set it active");
    expect(out).toContain("Set active phase");
    expect(out).toContain("Run TODO/CI_FIX tasks in active phase sequentially");
  });

  test("ixado config help: header and all subcommand usages", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-help-config-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "help"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    expect(out).toContain("Config commands:");
    expect(out).toContain("ixado config show");
    expect(out).toContain("ixado config mode <auto|manual>");
    expect(out).toContain("ixado config assignee <CLI_ADAPTER>");
    expect(out).toContain("ixado config recovery <maxAttempts:0-10>");
    expect(out).toContain("ixado config usage <on|off>");
  });

  test("ixado config help: all descriptions are stable", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-help-config-d-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "help"], sandbox);

    expect(result.exitCode).toBe(0);
    const out = result.stdout;
    expect(out).toContain("Show current global config");
    expect(out).toContain("Set default phase-loop mode");
    expect(out).toContain("Set default coding CLI");
    expect(out).toContain("Set exception recovery max attempts");
    expect(out).toContain("Enable/disable codexbar usage telemetry");
  });

  test("ixado web help: header and all subcommand usages", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-help-web-");
    sandboxes.push(sandbox);

    const result = runIxado(["web", "help"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    expect(out).toContain("Web commands:");
    expect(out).toContain("ixado web start [port]");
    expect(out).toContain("ixado web stop");
    expect(out).toContain("ixado web serve [port]");
  });

  test("ixado web help: all descriptions are stable", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-help-web-d-");
    sandboxes.push(sandbox);

    const result = runIxado(["web", "help"], sandbox);

    expect(result.exitCode).toBe(0);
    const out = result.stdout;
    expect(out).toContain("Start local web control center in background");
    expect(out).toContain("Stop local web control center");
    expect(out).toContain("Run web control center in foreground");
  });
});

// ── 3. Config command outcome summaries (P21-004) ────────────────────────────

describe("P21-005 config command outcome summaries", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((s) => s.cleanup()));
    sandboxes.length = 0;
  });

  test("config mode auto: stable outcome lines", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-mode-auto-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "mode", "auto"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    expect(out).toContain("Execution loop mode set to AUTO.");
    expect(out).toContain("Settings saved to ");
    expect(out).toContain("Scope: global defaults (");
    expect(out).not.toContain("Precedence: project settings override");
    expect(out).toContain(
      "Next:    Run 'ixado phase run' to apply the new mode.",
    );
  });

  test("config mode manual: stable outcome lines", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-mode-manual-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "mode", "manual"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    expect(out).toContain("Execution loop mode set to MANUAL.");
    expect(out).toContain("Settings saved to ");
    expect(out).toContain("Scope: global defaults (");
    expect(out).toContain(
      "Next:    Run 'ixado phase run' to apply the new mode.",
    );
  });

  test("config assignee MOCK_CLI: stable outcome lines", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-assignee-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "assignee", "MOCK_CLI"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    expect(out).toContain("Default coding CLI set to MOCK_CLI.");
    expect(out).toContain("Settings saved to ");
    expect(out).toContain("Scope: global defaults (");
    expect(out).not.toContain("Precedence: project settings override");
    expect(out).toContain(
      "Next:    Run 'ixado phase run' or 'ixado task start <n>' to use the new default.",
    );
  });

  test("config usage on: stable outcome lines", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-usage-on-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "usage", "on"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    expect(out).toContain("Codexbar usage telemetry set to ON.");
    expect(out).toContain("Settings saved to ");
    expect(out).toContain("Scope: global defaults (");
    expect(out).toContain("Next:    Usage data will be collected on next run.");
  });

  test("config usage off: stable outcome lines", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-usage-off-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "usage", "off"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    expect(out).toContain("Codexbar usage telemetry set to OFF.");
    expect(out).toContain("Settings saved to ");
    expect(out).toContain(
      "Next:    Usage data will not be collected on next run.",
    );
  });

  test("config recovery 2: stable outcome lines", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-recovery-2-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "recovery", "2"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    expect(out).toContain("Exception recovery max attempts set to 2.");
    expect(out).toContain("Settings saved to ");
    expect(out).toContain("Scope: global defaults (");
    expect(out).not.toContain("Precedence: project settings override");
    expect(out).toContain(
      "Next:    Run 'ixado phase run' to apply the updated recovery limit.",
    );
  });

  test("config usage off does not create local .ixado/settings.json", async () => {
    const sandbox = await TestSandbox.create(
      "ixado-p21-005-usage-global-only-",
    );
    sandboxes.push(sandbox);
    const localSettingsFilePath = join(
      sandbox.projectDir,
      ".ixado",
      "settings.json",
    );

    const result = runIxado(["config", "usage", "off"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(existsSync(localSettingsFilePath)).toBe(false);
    expect(result.stdout).toContain(
      `Settings saved to ${sandbox.globalConfigFile}.`,
    );
  });

  test("config recovery 0: value zero is accepted and reflected", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-recovery-0-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "recovery", "0"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Exception recovery max attempts set to 0.",
    );
    expect(result.stdout).toContain(
      "Next:    Run 'ixado phase run' to apply the updated recovery limit.",
    );
  });

  test("config outcome lines use 'Next:' label with 4-space padding (9-char field)", async () => {
    // "Next:    " is 9 chars (5 for "Next:" + 4 spaces), matching "Status:  " (7+2).
    const sandbox = await TestSandbox.create("ixado-p21-005-next-label-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "mode", "auto"], sandbox);

    expect(result.exitCode).toBe(0);
    // Verify the exact label+padding format used for all Next: lines.
    expect(result.stdout).toContain("Next:    Run 'ixado phase run'");
  });
});

// ── 4. Phase and task command outcome summaries (P21-004) ────────────────────

describe("P21-005 phase and task command outcome summaries", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((s) => s.cleanup()));
    sandboxes.length = 0;
  });

  test("phase create: Created + Status + Next lines are stable", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-phase-create-");
    sandboxes.push(sandbox);

    const result = runIxado(
      ["phase", "create", "My Phase", "my-branch"],
      sandbox,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    // Created line includes dynamic ID in parens.
    expect(out).toContain("Created phase My Phase (");
    // Status line includes branch and task count.
    expect(out).toContain("Status:  PLANNING — branch: my-branch, 0 task(s)");
    // Next line is exact.
    expect(out).toContain(
      "Next:    Add tasks with 'ixado task create <title> <description>', then run 'ixado phase run'.",
    );
  });

  test("phase active: Active + Status + Next lines are stable", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-phase-active-");
    sandboxes.push(sandbox);

    // Create two phases; the second becomes active.
    runIxado(["phase", "create", "Phase A", "branch-a"], sandbox);
    runIxado(["phase", "create", "Phase B", "branch-b"], sandbox);

    // Switch active to phase 1 (Phase A).
    const result = runIxado(["phase", "active", "1"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    expect(out).toContain("Active phase set to Phase A (");
    expect(out).toContain("Status:  PLANNING — 0 task(s)");
    expect(out).toContain(
      "Next:    Run 'ixado task list' to review tasks or 'ixado phase run' to start execution.",
    );
  });

  test("task create: Created + Status + Next lines are stable", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-task-create-");
    sandboxes.push(sandbox);

    runIxado(["phase", "create", "My Phase", "my-branch"], sandbox);

    const result = runIxado(
      ["task", "create", "Fix auth", "Fix the authentication bug"],
      sandbox,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    expect(out).toContain("Created task #1 in My Phase: Fix auth.");
    expect(out).toContain("Status:  TODO — assignee: UNASSIGNED");
    expect(out).toContain(
      "Next:    Run 'ixado task start 1' to start it, or 'ixado phase run' to run all TODO tasks.",
    );
  });

  test("task create with explicit assignee: status reflects assignee", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-task-assignee-");
    sandboxes.push(sandbox);

    runIxado(["phase", "create", "My Phase", "my-branch"], sandbox);

    const result = runIxado(
      ["task", "create", "Build it", "Build the thing", "MOCK_CLI"],
      sandbox,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status:  TODO — assignee: MOCK_CLI");
    expect(result.stdout).toContain(
      "Next:    Run 'ixado task start 1' to start it",
    );
  });

  test("task create: second task in same phase gets correct number", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-task-seq-");
    sandboxes.push(sandbox);

    runIxado(["phase", "create", "My Phase", "my-branch"], sandbox);
    runIxado(["task", "create", "First Task", "First description"], sandbox);

    const result = runIxado(
      ["task", "create", "Second Task", "Second description"],
      sandbox,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Created task #2 in My Phase: Second Task.",
    );
    expect(result.stdout).toContain(
      "Next:    Run 'ixado task start 2' to start it",
    );
  });
});

// ── 5. Project management outcome summaries (P21-004) ────────────────────────

describe("P21-005 project management outcome summaries", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((s) => s.cleanup()));
    sandboxes.length = 0;
  });

  test("init new project: Registered + Next lines are stable", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-init-new-");
    sandboxes.push(sandbox);

    const result = runIxado(["init"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    expect(out).toContain("Registered project '");
    expect(out).toContain("' at ");
    expect(out).toContain(" in global config.");
    expect(out).toContain("Next:    Run 'ixado switch ");
    expect(out).toContain(
      "' to set it active, then 'ixado phase create <name> <branch>'.",
    );
  });

  test("init already-registered project: already-registered + Next lines are stable", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-init-dup-");
    sandboxes.push(sandbox);

    runIxado(["init"], sandbox);
    const result = runIxado(["init"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    expect(out).toContain("is already registered at ");
    // Next line references switch + list.
    expect(out).toContain("Next:    Run 'ixado switch ");
    expect(out).toContain("ixado list");
  });

  test("switch: Switched + Next lines are stable", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-switch-");
    sandboxes.push(sandbox);

    runIxado(["init"], sandbox);

    // Derive project name from list output.
    const listResult = runIxado(["list"], sandbox);
    const match = /^\s+(\S+)\s+->/m.exec(listResult.stdout);
    const projectName = match?.[1] ?? "";
    expect(projectName).toBeTruthy();

    const result = runIxado(["switch", projectName], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      `Switched active project to '${projectName}' at `,
    );
    expect(result.stdout).toContain(
      "Next:    Run 'ixado status' to see phase and task state.",
    );
  });
});

// ── 6. Config show output structure (P21-003) ────────────────────────────────

describe("P21-005 config show output structure", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((s) => s.cleanup()));
    sandboxes.length = 0;
  });

  test("config show: all expected field labels are present", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-show-fields-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "show"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    expect(out).toContain("Settings file: ");
    expect(out).toContain("Scope: global defaults (");
    expect(out).not.toContain("Precedence: project settings override");
    expect(out).toContain("Execution loop mode: ");
    expect(out).toContain("Default coding CLI: ");
    expect(out).toContain("Exception recovery max attempts: ");
    expect(out).toContain("Codexbar usage telemetry: ");
  });

  test("config show: default values match DEFAULT_CLI_SETTINGS", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-show-defaults-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "show"], sandbox);

    expect(result.exitCode).toBe(0);
    const out = result.stdout;
    // DEFAULT_CLI_SETTINGS: autoMode=false, assignee=CODEX_CLI, maxAttempts=1, codexbarEnabled=true
    expect(out).toContain("Execution loop mode: MANUAL");
    expect(out).toContain("Default coding CLI: CODEX_CLI");
    expect(out).toContain("Exception recovery max attempts: 1");
    expect(out).toContain("Codexbar usage telemetry: ON");
  });

  test("config show: settings file path is global by default", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-show-path-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "show"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `Settings file: ${sandbox.globalConfigFile}`,
    );
  });

  test("config show: reflects config mode after change", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-show-reflect-");
    sandboxes.push(sandbox);

    runIxado(["config", "mode", "auto"], sandbox);
    const result = runIxado(["config", "show"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Execution loop mode: AUTO");
  });
});

// ── 7. Config precedence message format (P21-003) ────────────────────────────

describe("P21-005 config precedence message format", () => {
  const sandboxes: TestSandbox[] = [];
  const originalSettingsPath = process.env.IXADO_SETTINGS_FILE;

  afterEach(async () => {
    if (originalSettingsPath === undefined) {
      delete process.env.IXADO_SETTINGS_FILE;
    } else {
      process.env.IXADO_SETTINGS_FILE = originalSettingsPath;
    }
    await Promise.all(sandboxes.map((s) => s.cleanup()));
    sandboxes.length = 0;
  });

  test("config mutators: Scope line uses 'global defaults' wording", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-prec-project-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "mode", "auto"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Scope: global defaults (");
    expect(result.stdout).not.toContain(
      "Precedence: project settings override",
    );
  });

  test("global-scope: Scope line uses 'global defaults' wording and no Precedence line", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-prec-global-");
    sandboxes.push(sandbox);

    // Force settings path to the global config file so scope is global.
    process.env.IXADO_SETTINGS_FILE = sandbox.globalConfigFile;

    const result = runIxado(["config", "show"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Scope: global defaults (");
    expect(result.stdout).not.toContain(
      "Precedence: project settings override",
    );
  });

  test("mutation commands include global defaults scope in output", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-prec-mutate-");
    sandboxes.push(sandbox);

    // Each of the four config mutators should include the scope/precedence message.
    const cases: string[][] = [
      ["config", "mode", "auto"],
      ["config", "assignee", "MOCK_CLI"],
      ["config", "usage", "on"],
      ["config", "recovery", "3"],
    ];

    for (const args of cases) {
      const result = runIxado(args, sandbox);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Scope: global defaults (");
      expect(result.stdout).not.toContain(
        "Precedence: project settings override",
      );
    }
  });
});

// ── 8. Validation error format stability (supplement to P21-002) ─────────────

describe("P21-005 validation error format stability", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((s) => s.cleanup()));
    sandboxes.length = 0;
  });

  test("validation errors never include 'Startup failed:' prefix", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-val-startup-");
    sandboxes.push(sandbox);

    const cases = [
      ["nosuchcmd"],
      ["switch"],
      ["task", "start", "bad"],
      ["phase", "active"],
      ["config", "mode"],
      ["config", "mode", "bogus"],
      ["config", "assignee", "BAD_CLI"],
      ["config", "recovery", "99"],
    ];

    for (const args of cases) {
      const result = runIxado(args, sandbox);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toContain("Startup failed:");
    }
  });

  test("error messages always use capital-E 'Error:' prefix", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-val-prefix-");
    sandboxes.push(sandbox);

    const cases = [
      ["nosuchcmd"],
      ["task", "start", "abc"],
      ["phase", "active"],
      ["config", "mode", "wrong"],
      ["config", "assignee", "BAD_CLI"],
      ["config", "usage", "maybe"],
    ];

    for (const args of cases) {
      const result = runIxado(args, sandbox);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error: ");
      expect(result.stderr).not.toContain("error: ");
    }
  });

  test("validation errors with Usage include '  Usage:' prefix (2-space indent)", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-val-usage-indent-");
    sandboxes.push(sandbox);

    const cases: [string[], string][] = [
      [["task", "start", "abc"], "  Usage: ixado task start <taskNumber>"],
      [
        ["phase", "active"],
        "  Usage: ixado phase active <phaseNumber|phaseId>",
      ],
      [["config", "mode", "bad"], "  Usage: ixado config mode <auto|manual>"],
      [
        ["config", "recovery", "999"],
        "  Usage: ixado config recovery <maxAttempts:0-10>",
      ],
    ];

    for (const [args, expectedUsageLine] of cases) {
      const result = runIxado(args, sandbox);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(expectedUsageLine);
    }
  });

  test("validation errors with Hint include '  Hint:' prefix (2-space indent)", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-val-hint-indent-");
    sandboxes.push(sandbox);

    const cases = [
      ["task", "start", "bad"],
      ["phase", "active"],
      ["phase", "create", "name-only"],
      ["config", "mode", "wrong"],
      ["config", "assignee", "BAD"],
      ["config", "recovery", "999"],
    ];

    for (const args of cases) {
      const result = runIxado(args, sandbox);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("  Hint:");
    }
  });

  test("Error + Usage + Hint appear in the right order when all present", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-005-val-order-");
    sandboxes.push(sandbox);

    // "task start abc" triggers a full three-part message.
    const result = runIxado(["task", "start", "abc"], sandbox);

    expect(result.exitCode).toBe(1);
    const stderr = result.stderr;
    const errorIdx = stderr.indexOf("Error: ");
    const usageIdx = stderr.indexOf("  Usage: ");
    const hintIdx = stderr.indexOf("  Hint:");

    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeGreaterThan(errorIdx);
    expect(hintIdx).toBeGreaterThan(usageIdx);
  });
});

/**
 * P21-002: Unified argument validation error style.
 *
 * Tests assert that:
 * 1. ValidationError.format() produces the expected multi-line structure.
 * 2. Validation failures across command groups exit with code 1.
 * 3. Validation error output follows the consistent format (Error + Usage + Hint).
 * 4. Regular (non-validation) errors use "Error: <msg>" format (not "Startup failed:").
 * 5. Actionable remediation hints are present for every validation failure.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ValidationError } from "./validation";
import { TestSandbox, runIxado } from "./test-helpers";

// ---------------------------------------------------------------------------
// Unit tests for ValidationError
// ---------------------------------------------------------------------------

describe("ValidationError", () => {
  test("format includes Error prefix and message", () => {
    const err = new ValidationError("Something went wrong.");
    expect(err.format()).toBe("Error: Something went wrong.");
  });

  test("format includes Usage line when provided", () => {
    const err = new ValidationError("Bad arg.", {
      usage: "ixado task start <taskNumber>",
    });
    const formatted = err.format();
    expect(formatted).toContain("Error: Bad arg.");
    expect(formatted).toContain("  Usage: ixado task start <taskNumber>");
  });

  test("format includes Hint line when provided", () => {
    const err = new ValidationError("Bad arg.", {
      hint: "Run 'ixado task list'.",
    });
    const formatted = err.format();
    expect(formatted).toContain("Error: Bad arg.");
    expect(formatted).toContain("  Hint:  Run 'ixado task list'.");
  });

  test("format includes both Usage and Hint when both provided", () => {
    const err = new ValidationError("Bad arg.", {
      usage: "ixado cmd <arg>",
      hint: "Some hint.",
    });
    const lines = err.format().split("\n");
    expect(lines[0]).toBe("Error: Bad arg.");
    expect(lines[1]).toBe("  Usage: ixado cmd <arg>");
    expect(lines[2]).toBe("  Hint:  Some hint.");
  });

  test("is instanceof Error", () => {
    const err = new ValidationError("oops");
    expect(err).toBeInstanceOf(Error);
  });

  test("name is ValidationError", () => {
    const err = new ValidationError("oops");
    expect(err.name).toBe("ValidationError");
  });

  test("message is accessible on the instance", () => {
    const err = new ValidationError("the message");
    expect(err.message).toBe("the message");
  });
});

// ---------------------------------------------------------------------------
// CLI integration tests – validation error format and exit behavior
// ---------------------------------------------------------------------------

describe("P21-002 CLI argument validation", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((s) => s.cleanup()));
    sandboxes.length = 0;
  });

  // Helper: assert standard validation error shape on stderr.
  function assertValidationError(
    stderr: string,
    expectedMessage: string,
    expectedUsage?: string,
    expectedHint?: string,
  ): void {
    expect(stderr).toContain(`Error: ${expectedMessage}`);
    if (expectedUsage) {
      expect(stderr).toContain(`  Usage: ${expectedUsage}`);
    }
    if (expectedHint) {
      expect(stderr).toContain(`  Hint:`);
      expect(stderr).toContain(expectedHint);
    }
  }

  // ── unknown command ──────────────────────────────────────────────────────

  test("unknown command: exits 1 with Error + hint (not Startup failed)", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-unknown-");
    sandboxes.push(sandbox);

    const result = runIxado(["nosuchcmd"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: Unknown command: 'nosuchcmd'");
    expect(result.stderr).toContain("Run 'ixado help'");
    expect(result.stderr).not.toContain("Startup failed:");
  });

  // ── switch command ───────────────────────────────────────────────────────

  test("switch: missing project name exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-switch-missing-");
    sandboxes.push(sandbox);

    const result = runIxado(["switch"], sandbox);

    expect(result.exitCode).toBe(1);
    assertValidationError(
      result.stderr,
      "Missing required argument: <project-name>.",
      "ixado switch <project-name>",
      "ixado list",
    );
  });

  test("switch: unknown project exits 1 with Error + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-switch-notfound-");
    sandboxes.push(sandbox);

    const result = runIxado(["switch", "nonexistent-project"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Error: Project 'nonexistent-project' not found.",
    );
    expect(result.stderr).toContain("  Hint:");
  });

  // ── task commands ────────────────────────────────────────────────────────

  test("task start: missing number exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-task-start-missing-");
    sandboxes.push(sandbox);

    const result = runIxado(["task", "start"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Expected a positive integer");
    expect(result.stderr).toContain("  Usage: ixado task start <taskNumber>");
    expect(result.stderr).toContain("  Hint:");
    expect(result.stderr).toContain("ixado task list");
  });

  test("task start: non-integer arg exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-task-start-bad-");
    sandboxes.push(sandbox);

    const result = runIxado(["task", "start", "abc"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: Invalid task number: 'abc'.");
    expect(result.stderr).toContain("  Usage: ixado task start <taskNumber>");
    expect(result.stderr).toContain("  Hint:");
    expect(result.stderr).toContain("ixado task list");
  });

  test("task logs: non-integer arg exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-task-logs-bad-");
    sandboxes.push(sandbox);

    const result = runIxado(["task", "logs", "x"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: Invalid task number: 'x'.");
    expect(result.stderr).toContain("  Usage: ixado task logs <taskNumber>");
    expect(result.stderr).toContain("  Hint:");
  });

  test("task reset: non-integer arg exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-task-reset-bad-");
    sandboxes.push(sandbox);

    const result = runIxado(["task", "reset", "bad"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: Invalid task number: 'bad'.");
    expect(result.stderr).toContain("  Usage: ixado task reset <taskNumber>");
    expect(result.stderr).toContain("  Hint:");
  });

  test("task retry: non-integer arg exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-task-retry-bad-");
    sandboxes.push(sandbox);

    const result = runIxado(["task", "retry", "xyz"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: Invalid task number: 'xyz'.");
    expect(result.stderr).toContain("  Usage: ixado task retry <taskNumber>");
    expect(result.stderr).toContain("  Hint:");
  });

  test("task create: missing description exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-task-create-missing-");
    sandboxes.push(sandbox);

    const result = runIxado(["task", "create", "title-only"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Error: Missing required arguments: <title> and <description>.",
    );
    expect(result.stderr).toContain(
      "  Usage: ixado task create <title> <description> [assignee]",
    );
    expect(result.stderr).toContain("  Hint:");
  });

  test("task create: invalid assignee exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-task-create-assignee-");
    sandboxes.push(sandbox);

    // Need a phase first so we can reach the assignee-validation step
    const phaseResult = runIxado(
      ["phase", "create", "Phase X", "branch-x"],
      sandbox,
    );
    expect(phaseResult.exitCode).toBe(0);

    const result = runIxado(
      ["task", "create", "My Task", "Some description", "BAD_CLI"],
      sandbox,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: Invalid assignee: 'BAD_CLI'.");
    expect(result.stderr).toContain(
      "  Usage: ixado task create <title> <description> [assignee]",
    );
    expect(result.stderr).toContain("  Hint:");
    expect(result.stderr).toContain("assignee must be one of");
  });

  // ── phase commands ───────────────────────────────────────────────────────

  test("phase run: invalid mode exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-phase-run-mode-");
    sandboxes.push(sandbox);

    const result = runIxado(["phase", "run", "always"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: Invalid phase run mode: 'always'.");
    expect(result.stderr).toContain(
      "  Usage: ixado phase run [auto|manual] [countdownSeconds>=0]",
    );
    expect(result.stderr).toContain("  Hint:");
  });

  test("phase run: negative countdown exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-phase-run-neg-");
    sandboxes.push(sandbox);

    const result = runIxado(["phase", "run", "auto", "-5"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Error: Invalid countdown seconds: '-5'. Expected a non-negative integer.",
    );
    expect(result.stderr).toContain(
      "  Usage: ixado phase run [auto|manual] [countdownSeconds>=0]",
    );
    expect(result.stderr).toContain("  Hint:");
  });

  test("phase active: missing arg exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-phase-active-");
    sandboxes.push(sandbox);

    const result = runIxado(["phase", "active"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Error: Missing required argument: <phaseNumber|phaseId>.",
    );
    expect(result.stderr).toContain(
      "  Usage: ixado phase active <phaseNumber|phaseId>",
    );
    expect(result.stderr).toContain("  Hint:");
    expect(result.stderr).toContain("ixado phase list");
  });

  test("phase create: missing branchName exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-phase-create-miss-");
    sandboxes.push(sandbox);

    const result = runIxado(["phase", "create", "Name Only"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Error: Missing required arguments: <name> and <branchName>.",
    );
    expect(result.stderr).toContain(
      "  Usage: ixado phase create <name> <branchName>",
    );
    expect(result.stderr).toContain("  Hint:");
  });

  // ── config commands ──────────────────────────────────────────────────────

  test("config mode: missing arg exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-config-mode-miss-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "mode"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Error: Missing required argument: <auto|manual>.",
    );
    expect(result.stderr).toContain("  Usage: ixado config mode <auto|manual>");
    expect(result.stderr).toContain("  Hint:");
  });

  test("config mode: invalid value exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-config-mode-bad-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "mode", "always"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Error: Invalid mode: 'always'. Expected 'auto' or 'manual'.",
    );
    expect(result.stderr).toContain("  Usage: ixado config mode <auto|manual>");
    expect(result.stderr).toContain("  Hint:");
  });

  test("config assignee: missing arg exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-config-assign-miss-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "assignee"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Error: Missing required argument: <CODEX_CLI|CLAUDE_CLI|GEMINI_CLI|MOCK_CLI>.",
    );
    expect(result.stderr).toContain(
      "  Usage: ixado config assignee <CODEX_CLI|CLAUDE_CLI|GEMINI_CLI|MOCK_CLI>",
    );
    expect(result.stderr).toContain("  Hint:");
  });

  test("config assignee: invalid value exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-config-assign-bad-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "assignee", "UNKNOWN_CLI"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: Invalid assignee: 'UNKNOWN_CLI'.");
    expect(result.stderr).toContain(
      "  Usage: ixado config assignee <CODEX_CLI|CLAUDE_CLI|GEMINI_CLI|MOCK_CLI>",
    );
    expect(result.stderr).toContain("  Hint:");
    expect(result.stderr).toContain("Valid values:");
  });

  test("config usage: missing arg exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-config-usage-miss-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "usage"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Error: Missing required argument: <on|off>.",
    );
    expect(result.stderr).toContain("  Usage: ixado config usage <on|off>");
    expect(result.stderr).toContain("  Hint:");
  });

  test("config usage: invalid value exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-config-usage-bad-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "usage", "maybe"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Error: Invalid toggle value: 'maybe'. Expected 'on' or 'off'.",
    );
    expect(result.stderr).toContain("  Usage: ixado config usage <on|off>");
    expect(result.stderr).toContain("  Hint:");
  });

  test("config recovery: missing arg exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-config-rec-miss-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "recovery"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Error: Missing required argument: <maxAttempts:0-10>.",
    );
    expect(result.stderr).toContain(
      "  Usage: ixado config recovery <maxAttempts:0-10>",
    );
    expect(result.stderr).toContain("  Hint:");
  });

  test("config recovery: out-of-range value exits 1 with Usage + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-config-rec-bad-");
    sandboxes.push(sandbox);

    const result = runIxado(["config", "recovery", "99"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Error: Invalid recovery max attempts: '99'. Expected an integer from 0 to 10.",
    );
    expect(result.stderr).toContain(
      "  Usage: ixado config recovery <maxAttempts:0-10>",
    );
    expect(result.stderr).toContain("  Hint:");
  });

  // ── web commands ─────────────────────────────────────────────────────────

  test("web start: invalid port exits 1 with Error + hint", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-web-port-bad-");
    sandboxes.push(sandbox);

    const result = runIxado(["web", "start", "notaport"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Error: Invalid web port: 'notaport'. Expected an integer from 0 to 65535.",
    );
    expect(result.stderr).toContain("  Hint:");
    expect(result.stderr).toContain("3000");
  });

  // ── runtime (non-validation) errors use "Error:" not "Startup failed:" ──

  test("runtime error format is 'Error: <msg>' not 'Startup failed: <msg>'", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-runtime-err-");
    sandboxes.push(sandbox);

    // phase run with no phases fails with a runtime error
    const result = runIxado(["phase", "run", "auto", "0"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("Startup failed:");
    // The runtime error is wrapped as "Error: ..."
    expect(result.stderr).toContain("No phases found in project state");
  });

  test("task create fails fast when activePhaseId is missing", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-active-phase-missing-");
    sandboxes.push(sandbox);

    const initialState = {
      projectName: "test-project",
      rootDir: sandbox.projectDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phases: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Phase 1",
          branchName: "feature/phase-1",
          status: "PLANNING",
          tasks: [],
        },
      ],
      activePhaseId: undefined,
    };
    await sandbox.writeProjectState(initialState as any);

    const result = runIxado(
      ["task", "create", "Task A", "Task description"],
      sandbox,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Error: Active phase ID is not set in project state.",
    );
    expect(result.stderr).toContain("ixado phase active <phaseNumber|phaseId>");
  });

  // ── exit code consistency ─────────────────────────────────────────────────

  test("all validation errors produce exit code 1", async () => {
    const sandbox = await TestSandbox.create("ixado-p21-exitcodes-");
    sandboxes.push(sandbox);

    const cases = [
      ["nosuchcmd"],
      ["switch"],
      ["task", "start", "abc"],
      ["task", "logs"],
      ["task", "reset", "notanumber"],
      ["task", "retry", "0"],
      ["task", "create", "only-title"],
      ["phase", "active"],
      ["phase", "create", "name-only"],
      ["phase", "run", "bogus"],
      ["config", "mode"],
      ["config", "mode", "wrong"],
      ["config", "assignee"],
      ["config", "assignee", "BAD"],
      ["config", "usage"],
      ["config", "usage", "yes"],
      ["config", "recovery"],
      ["config", "recovery", "999"],
      ["web", "start", "99999999"],
    ];

    for (const args of cases) {
      const result = runIxado(args, sandbox);
      expect(result.exitCode).toBe(1);
    }
  });
});

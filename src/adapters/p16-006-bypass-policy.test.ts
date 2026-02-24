/**
 * P16-006: Adapter/recovery tests proving safe-mode defaults and explicit bypass behavior.
 *
 * Verifies that:
 *   1. CodexAdapter defaults to safe mode (no bypass flag) when no options are provided.
 *   2. CodexAdapter emits the bypass flag ONLY when explicitly enabled via options.
 *   3. Explicit `bypassApprovalsAndSandbox: false` behaves identically to the default.
 *   4. The factory (`createAdapter`) forwards bypass policy correctly for CODEX_CLI.
 *   5. DEFAULT_CLI_SETTINGS defaults every adapter's bypassApprovalsAndSandbox to false.
 *   6. The bypass flag never appears more than once, even with extra baseArgs.
 *   7. Recovery invocations use safe-mode adapters by default (runInternalWork assignee
 *      is forwarded unchanged; the adapter created from factory default settings has
 *      no bypass flag).
 *   8. Non-Codex adapters (Claude, Gemini) are not affected by bypassApprovalsAndSandbox.
 */

import { describe, expect, test } from "bun:test";

import { DEFAULT_CLI_SETTINGS } from "../cli/settings";
import {
  classifyRecoveryException,
  runExceptionRecovery,
} from "../engine/exception-recovery";
import { DEFAULT_AUTH_POLICY } from "../security/policy";
import { ClaudeAdapter } from "./claude-adapter";
import { CodexAdapter } from "./codex-adapter";
import { createAdapter } from "./factory";
import { GeminiAdapter } from "./gemini-adapter";
import { MockProcessRunner } from "./test-utils";

const BYPASS_FLAG = "--dangerously-bypass-approvals-and-sandbox";

// ---------------------------------------------------------------------------
// CodexAdapter: safe-mode by default
// ---------------------------------------------------------------------------

describe("CodexAdapter safe-mode defaults (P16-006)", () => {
  test("default construction emits no bypass flag in baseArgs", () => {
    const runner = new MockProcessRunner();
    const adapter = new CodexAdapter(runner);
    expect(adapter.contract.baseArgs).not.toContain(BYPASS_FLAG);
  });

  test("default construction: only exec appears in baseArgs", () => {
    const runner = new MockProcessRunner();
    const adapter = new CodexAdapter(runner);
    expect(adapter.contract.baseArgs).toEqual(["exec"]);
  });

  test("explicit bypassApprovalsAndSandbox: false is identical to the default", () => {
    const runnerDefault = new MockProcessRunner();
    const runnerExplicit = new MockProcessRunner();
    const adapterDefault = new CodexAdapter(runnerDefault);
    const adapterExplicit = new CodexAdapter(runnerExplicit, {
      bypassApprovalsAndSandbox: false,
    });
    expect(adapterDefault.contract.baseArgs).toEqual(
      adapterExplicit.contract.baseArgs,
    );
    expect(adapterExplicit.contract.baseArgs).not.toContain(BYPASS_FLAG);
  });

  test("safe-mode adapter runs successfully and spawns no bypass flag", async () => {
    const runner = new MockProcessRunner([{ stdout: "done", exitCode: 0 }]);
    const adapter = new CodexAdapter(runner);
    const result = await adapter.run({
      prompt: "do the thing",
      cwd: "/project",
    });
    expect(result.stdout).toBe("done");
    expect(runner.calls[0]?.args).not.toContain(BYPASS_FLAG);
  });

  test("safe-mode adapter with extra baseArgs still emits no bypass flag", async () => {
    const runner = new MockProcessRunner([{ stdout: "ok", exitCode: 0 }]);
    const adapter = new CodexAdapter(runner, { baseArgs: ["--timeout", "30"] });
    await adapter.run({ prompt: "run something", cwd: "/project" });
    expect(runner.calls[0]?.args).not.toContain(BYPASS_FLAG);
  });
});

// ---------------------------------------------------------------------------
// CodexAdapter: bypass only when explicitly enabled
// ---------------------------------------------------------------------------

describe("CodexAdapter bypass only when explicitly enabled (P16-006)", () => {
  test("bypassApprovalsAndSandbox: true adds the bypass flag to baseArgs", () => {
    const runner = new MockProcessRunner();
    const adapter = new CodexAdapter(runner, {
      bypassApprovalsAndSandbox: true,
    });
    expect(adapter.contract.baseArgs).toContain(BYPASS_FLAG);
  });

  test("bypass flag appears exactly once even when extra baseArgs are supplied", async () => {
    const runner = new MockProcessRunner([{ stdout: "ok", exitCode: 0 }]);
    const adapter = new CodexAdapter(runner, {
      bypassApprovalsAndSandbox: true,
      baseArgs: ["--timeout", "60"],
    });
    await adapter.run({ prompt: "task", cwd: "/project" });
    const bypassCount = (runner.calls[0]?.args ?? []).filter(
      (a) => a === BYPASS_FLAG,
    ).length;
    expect(bypassCount).toBe(1);
  });

  test("bypass flag is between exec and extra args in the final command", async () => {
    const runner = new MockProcessRunner([{ stdout: "", exitCode: 0 }]);
    const adapter = new CodexAdapter(runner, {
      bypassApprovalsAndSandbox: true,
    });
    await adapter.run({ prompt: "p", cwd: "/cwd" });
    const args = runner.calls[0]?.args ?? [];
    const execIdx = args.indexOf("exec");
    const bypassIdx = args.indexOf(BYPASS_FLAG);
    expect(execIdx).toBeLessThan(bypassIdx);
  });
});

// ---------------------------------------------------------------------------
// Factory: forwards bypass policy for CODEX_CLI
// ---------------------------------------------------------------------------

describe("createAdapter bypass policy (P16-006)", () => {
  test("factory with no options creates CODEX_CLI in safe mode", () => {
    const runner = new MockProcessRunner();
    const adapter = createAdapter("CODEX_CLI", runner);
    expect(adapter.contract.baseArgs).not.toContain(BYPASS_FLAG);
    expect(adapter.contract.baseArgs).toEqual(["exec"]);
  });

  test("factory with bypassApprovalsAndSandbox: false creates CODEX_CLI in safe mode", () => {
    const runner = new MockProcessRunner();
    const adapter = createAdapter("CODEX_CLI", runner, {
      bypassApprovalsAndSandbox: false,
    });
    expect(adapter.contract.baseArgs).not.toContain(BYPASS_FLAG);
  });

  test("factory with bypassApprovalsAndSandbox: true creates CODEX_CLI with bypass flag", () => {
    const runner = new MockProcessRunner();
    const adapter = createAdapter("CODEX_CLI", runner, {
      bypassApprovalsAndSandbox: true,
    });
    expect(adapter.contract.baseArgs).toContain(BYPASS_FLAG);
  });

  test("factory safe-mode CODEX_CLI adapter runs without emitting bypass flag", async () => {
    const runner = new MockProcessRunner([{ stdout: "output", exitCode: 0 }]);
    const adapter = createAdapter("CODEX_CLI", runner);
    await adapter.run({ prompt: "work", cwd: "/project" });
    expect(runner.calls[0]?.args).not.toContain(BYPASS_FLAG);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_CLI_SETTINGS: bypassApprovalsAndSandbox defaults to false
// ---------------------------------------------------------------------------

describe("DEFAULT_CLI_SETTINGS safe-mode defaults (P16-006)", () => {
  test("CODEX_CLI bypassApprovalsAndSandbox defaults to false", () => {
    expect(
      DEFAULT_CLI_SETTINGS.agents.CODEX_CLI.bypassApprovalsAndSandbox,
    ).toBe(false);
  });

  test("CLAUDE_CLI bypassApprovalsAndSandbox defaults to false", () => {
    expect(
      DEFAULT_CLI_SETTINGS.agents.CLAUDE_CLI.bypassApprovalsAndSandbox,
    ).toBe(false);
  });

  test("GEMINI_CLI bypassApprovalsAndSandbox defaults to false", () => {
    expect(
      DEFAULT_CLI_SETTINGS.agents.GEMINI_CLI.bypassApprovalsAndSandbox,
    ).toBe(false);
  });

  test("MOCK_CLI bypassApprovalsAndSandbox defaults to false", () => {
    expect(DEFAULT_CLI_SETTINGS.agents.MOCK_CLI.bypassApprovalsAndSandbox).toBe(
      false,
    );
  });

  test("factory built from DEFAULT_CLI_SETTINGS creates CODEX_CLI in safe mode", () => {
    const runner = new MockProcessRunner();
    const settings = DEFAULT_CLI_SETTINGS.agents.CODEX_CLI;
    const adapter = createAdapter("CODEX_CLI", runner, {
      bypassApprovalsAndSandbox: settings.bypassApprovalsAndSandbox,
    });
    expect(adapter.contract.baseArgs).not.toContain(BYPASS_FLAG);
  });
});

// ---------------------------------------------------------------------------
// Non-Codex adapters: unaffected by bypassApprovalsAndSandbox
// ---------------------------------------------------------------------------

describe("Non-Codex adapters are unaffected by bypass flag (P16-006)", () => {
  test("ClaudeAdapter never includes Codex bypass flag regardless of options", async () => {
    const runner = new MockProcessRunner([{ stdout: "", exitCode: 0 }]);
    // ClaudeAdapter does not accept bypassApprovalsAndSandbox in its own opts,
    // but confirm the factory does not inject it for CLAUDE_CLI.
    const adapter = createAdapter("CLAUDE_CLI", runner, {
      bypassApprovalsAndSandbox: true,
    });
    await adapter.run({ prompt: "task", cwd: "/project" });
    expect(runner.calls[0]?.args).not.toContain(BYPASS_FLAG);
  });

  test("GeminiAdapter never includes Codex bypass flag regardless of options", async () => {
    const runner = new MockProcessRunner([{ stdout: "", exitCode: 0 }]);
    const adapter = createAdapter("GEMINI_CLI", runner, {
      bypassApprovalsAndSandbox: true,
    });
    await adapter.run({ prompt: "task", cwd: "/project" });
    expect(runner.calls[0]?.args).not.toContain(BYPASS_FLAG);
  });

  test("ClaudeAdapter direct construction has no Codex bypass flag", async () => {
    const runner = new MockProcessRunner([{ stdout: "", exitCode: 0 }]);
    const adapter = new ClaudeAdapter(runner);
    await adapter.run({ prompt: "task", cwd: "/project" });
    expect(runner.calls[0]?.args).not.toContain(BYPASS_FLAG);
  });

  test("GeminiAdapter direct construction has no Codex bypass flag", async () => {
    const runner = new MockProcessRunner([{ stdout: "", exitCode: 0 }]);
    const adapter = new GeminiAdapter(runner);
    await adapter.run({ prompt: "task", cwd: "/project" });
    expect(runner.calls[0]?.args).not.toContain(BYPASS_FLAG);
  });
});

// ---------------------------------------------------------------------------
// Recovery path: safe-mode by default
// ---------------------------------------------------------------------------

describe("runExceptionRecovery uses safe-mode adapter by default (P16-006)", () => {
  test("recovery passes assignee to runInternalWork unchanged", async () => {
    const exception = classifyRecoveryException({
      message: "Git working tree is not clean.",
      category: "DIRTY_WORKTREE",
    });

    const capturedWork: Array<{ assignee: string }> = [];

    await runExceptionRecovery({
      cwd: process.cwd(),
      assignee: "CODEX_CLI",
      exception,
      attemptNumber: 1,
      role: "admin",
      policy: DEFAULT_AUTH_POLICY,
      runInternalWork: async (work) => {
        capturedWork.push({ assignee: work.assignee });
        return {
          stdout:
            '{"status":"fixed","reasoning":"cleaned tree","actionsTaken":["git add .","git commit -m \\"fix\\""],"filesTouched":[]}',
          stderr: "",
        };
      },
    });

    expect(capturedWork).toHaveLength(1);
    expect(capturedWork[0]?.assignee).toBe("CODEX_CLI");
  });

  test("attempt-1 DIRTY_WORKTREE recovery prompt is plain cleanup nudge with no bypass flag", async () => {
    const exception = classifyRecoveryException({
      message: "Git working tree is not clean.",
      category: "DIRTY_WORKTREE",
    });

    let capturedPrompt = "";

    await runExceptionRecovery({
      cwd: process.cwd(),
      assignee: "CODEX_CLI",
      exception,
      attemptNumber: 1,
      role: "admin",
      policy: DEFAULT_AUTH_POLICY,
      runInternalWork: async (work) => {
        capturedPrompt = work.prompt;
        return {
          stdout:
            '{"status":"fixed","reasoning":"done","actionsTaken":["git add ."],"filesTouched":[]}',
          stderr: "",
        };
      },
    });

    // The attempt-1 prompt is plain natural-language cleanup guidance.
    expect(capturedPrompt).not.toContain(BYPASS_FLAG);
    expect(capturedPrompt).toBe(
      "You left uncommitted changes. Please `git add` and `git commit` all your work with a descriptive message, then verify the repository is clean.",
    );
  });

  test("safe-mode factory adapter used in recovery simulation completes without bypass flag", async () => {
    // Simulate how the real execution path creates an adapter from settings
    // and passes it into runInternalWork for recovery.
    const adapterRunner = new MockProcessRunner([
      {
        stdout:
          '{"status":"fixed","reasoning":"cleaned up","actionsTaken":["git add .","git commit -m \\"fix\\""],"filesTouched":[]}',
        exitCode: 0,
      },
    ]);
    const agentSettings = DEFAULT_CLI_SETTINGS.agents.CODEX_CLI;
    const recoveryAdapter = createAdapter("CODEX_CLI", adapterRunner, {
      bypassApprovalsAndSandbox: agentSettings.bypassApprovalsAndSandbox,
    });

    const exception = classifyRecoveryException({
      message: "Git working tree is not clean.",
      category: "DIRTY_WORKTREE",
    });

    await runExceptionRecovery({
      cwd: process.cwd(),
      assignee: "CODEX_CLI",
      exception,
      attemptNumber: 1,
      role: "admin",
      policy: DEFAULT_AUTH_POLICY,
      runInternalWork: async (work) => {
        // Simulate the real code path: create adapter from settings, run it.
        const result = await recoveryAdapter.run({
          prompt: work.prompt,
          cwd: process.cwd(),
        });
        return { stdout: result.stdout, stderr: result.stderr };
      },
    });

    // Confirm no bypass flag was emitted by the adapter.
    expect(adapterRunner.calls[0]?.args).not.toContain(BYPASS_FLAG);
  });
});

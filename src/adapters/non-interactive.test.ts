/**
 * P11-001: Non-interactive execution enforcement tests.
 *
 * Verifies that Claude/Codex/Gemini adapters:
 *   1. Require their batch-mode flags at construction time.
 *   2. Reject known interactive-mode flags at construction time.
 *   3. Re-validate before every `run()` call (defence-in-depth).
 *   4. Do not obstruct the MockCLIAdapter (no policy attached).
 *
 * The `assertNonInteractive` helper is also tested in isolation so the policy
 * logic can be verified independently of the adapter wiring.
 */

import { describe, expect, test } from "bun:test";

import { ClaudeAdapter } from "./claude-adapter";
import { CodexAdapter } from "./codex-adapter";
import { GeminiAdapter } from "./gemini-adapter";
import { MockCLIAdapter } from "./mock-adapter";
import {
  assertNonInteractive,
  BaseCliAdapter,
  InteractiveModeError,
} from "./types";
import type { NonInteractiveConfig } from "./types";
import { MockProcessRunner } from "./test-utils";

// ---------------------------------------------------------------------------
// assertNonInteractive helper
// ---------------------------------------------------------------------------

describe("assertNonInteractive", () => {
  const config: NonInteractiveConfig = {
    requiredArgs: ["--batch"],
    forbiddenArgs: ["--interactive", "-i"],
  };

  test("passes when all required args are present and no forbidden args exist", () => {
    expect(() =>
      assertNonInteractive("TEST", ["--batch", "--quiet"], config),
    ).not.toThrow();
  });

  test("throws InteractiveModeError when a required arg is missing", () => {
    expect(() => assertNonInteractive("TEST", ["--quiet"], config)).toThrow(
      InteractiveModeError,
    );
    expect(() => assertNonInteractive("TEST", ["--quiet"], config)).toThrow(
      '[TEST] Interactive mode rejected: required non-interactive flag "--batch" is missing from args',
    );
  });

  test("throws InteractiveModeError when a forbidden arg is present", () => {
    expect(() =>
      assertNonInteractive("TEST", ["--batch", "--interactive"], config),
    ).toThrow(InteractiveModeError);
    expect(() =>
      assertNonInteractive("TEST", ["--batch", "--interactive"], config),
    ).toThrow(
      '[TEST] Interactive mode rejected: interactive flag "--interactive" is not permitted',
    );
  });

  test("throws for -i shorthand forbidden arg", () => {
    expect(() =>
      assertNonInteractive("TEST", ["--batch", "-i"], config),
    ).toThrow(InteractiveModeError);
  });

  test("InteractiveModeError has the correct name property", () => {
    try {
      assertNonInteractive("ADAPTER", [], config);
    } catch (err) {
      expect(err).toBeInstanceOf(InteractiveModeError);
      expect((err as InteractiveModeError).name).toBe("InteractiveModeError");
    }
  });

  test("passes with empty required and forbidden lists", () => {
    expect(() =>
      assertNonInteractive("MOCK", ["any", "args"], {
        requiredArgs: [],
        forbiddenArgs: [],
      }),
    ).not.toThrow();
  });

  test("checks every required arg independently", () => {
    const multi: NonInteractiveConfig = {
      requiredArgs: ["--a", "--b"],
      forbiddenArgs: [],
    };
    // only --a present → fails on --b
    expect(() => assertNonInteractive("X", ["--a"], multi)).toThrow(
      'required non-interactive flag "--b" is missing',
    );
    // neither present → fails on first missing (--a)
    expect(() => assertNonInteractive("X", [], multi)).toThrow(
      'required non-interactive flag "--a" is missing',
    );
    // both present → passes
    expect(() =>
      assertNonInteractive("X", ["--a", "--b"], multi),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// BaseCliAdapter construction-time enforcement
// ---------------------------------------------------------------------------

describe("BaseCliAdapter non-interactive construction guard", () => {
  // Minimal concrete subclass for testing the base directly.
  class TestAdapter extends BaseCliAdapter {
    constructor(
      runner: MockProcessRunner,
      args: string[],
      config: NonInteractiveConfig,
    ) {
      super({
        id: "MOCK_CLI",
        command: "test-cmd",
        baseArgs: args,
        nonInteractiveConfig: config,
        runner,
      });
    }
  }

  test("throws InteractiveModeError at construction when required arg is absent", () => {
    const runner = new MockProcessRunner();
    expect(
      () =>
        new TestAdapter(runner, ["--other"], {
          requiredArgs: ["--batch"],
          forbiddenArgs: [],
        }),
    ).toThrow(InteractiveModeError);
  });

  test("throws InteractiveModeError at construction when forbidden arg is present", () => {
    const runner = new MockProcessRunner();
    expect(
      () =>
        new TestAdapter(runner, ["--batch", "--interactive"], {
          requiredArgs: ["--batch"],
          forbiddenArgs: ["--interactive"],
        }),
    ).toThrow(InteractiveModeError);
  });

  test("does not throw when config is satisfied", () => {
    const runner = new MockProcessRunner([{ stdout: "ok" }]);
    expect(
      () =>
        new TestAdapter(runner, ["--batch"], {
          requiredArgs: ["--batch"],
          forbiddenArgs: ["--interactive"],
        }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ClaudeAdapter
// ---------------------------------------------------------------------------

describe("ClaudeAdapter non-interactive enforcement", () => {
  test("valid construction does not throw", () => {
    const runner = new MockProcessRunner();
    expect(() => new ClaudeAdapter(runner)).not.toThrow();
  });

  test("always has --print in baseArgs (non-interactive batch flag)", () => {
    const runner = new MockProcessRunner();
    const adapter = new ClaudeAdapter(runner);
    expect(adapter.contract.baseArgs).toContain("--print");
  });

  test("run() succeeds with valid non-interactive configuration", async () => {
    const runner = new MockProcessRunner([{ stdout: "result" }]);
    const adapter = new ClaudeAdapter(runner);
    const result = await adapter.run({ prompt: "do work", cwd: "/repo" });
    expect(result.stdout).toBe("result");
    // --print must appear in the spawned args
    expect(runner.calls[0]?.args).toContain("--print");
  });

  test("construction with extra baseArgs still preserves --print", () => {
    const runner = new MockProcessRunner();
    const adapter = new ClaudeAdapter(runner, {
      baseArgs: ["--model", "sonnet"],
    });
    expect(adapter.contract.baseArgs).toContain("--print");
  });
});

// ---------------------------------------------------------------------------
// CodexAdapter
// ---------------------------------------------------------------------------

describe("CodexAdapter non-interactive enforcement", () => {
  test("valid construction does not throw", () => {
    const runner = new MockProcessRunner();
    expect(() => new CodexAdapter(runner)).not.toThrow();
  });

  test("always has exec in baseArgs (batch subcommand)", () => {
    const runner = new MockProcessRunner();
    const adapter = new CodexAdapter(runner);
    expect(adapter.contract.baseArgs).toContain("exec");
  });

  test("throws InteractiveModeError when 'chat' interactive subcommand is injected", () => {
    const runner = new MockProcessRunner();
    // Attempting to add 'chat' after the required args should be rejected.
    expect(() => new CodexAdapter(runner, { baseArgs: ["chat"] })).toThrow(
      InteractiveModeError,
    );
    expect(() => new CodexAdapter(runner, { baseArgs: ["chat"] })).toThrow(
      'interactive flag "chat" is not permitted',
    );
  });

  test("throws InteractiveModeError when 'interactive' subcommand is injected", () => {
    const runner = new MockProcessRunner();
    expect(
      () => new CodexAdapter(runner, { baseArgs: ["interactive"] }),
    ).toThrow(InteractiveModeError);
    expect(
      () => new CodexAdapter(runner, { baseArgs: ["interactive"] }),
    ).toThrow('interactive flag "interactive" is not permitted');
  });

  test("run() succeeds with valid non-interactive configuration", async () => {
    const runner = new MockProcessRunner([{ stdout: "done" }]);
    const adapter = new CodexAdapter(runner);
    const result = await adapter.run({ prompt: "fix bug", cwd: "/repo" });
    expect(result.stdout).toBe("done");
    expect(runner.calls[0]?.args).toContain("exec");
  });
});

// ---------------------------------------------------------------------------
// GeminiAdapter
// ---------------------------------------------------------------------------

describe("GeminiAdapter non-interactive enforcement", () => {
  test("valid construction does not throw", () => {
    const runner = new MockProcessRunner();
    expect(() => new GeminiAdapter(runner)).not.toThrow();
  });

  test("always has --yolo in baseArgs (non-interactive batch flag)", () => {
    const runner = new MockProcessRunner();
    const adapter = new GeminiAdapter(runner);
    expect(adapter.contract.baseArgs).toContain("--yolo");
  });

  test("run() succeeds with valid non-interactive configuration", async () => {
    const runner = new MockProcessRunner([{ stdout: "output" }]);
    const adapter = new GeminiAdapter(runner);
    const result = await adapter.run({ prompt: "write tests", cwd: "/repo" });
    expect(result.stdout).toBe("output");
    expect(runner.calls[0]?.args).toContain("--yolo");
  });

  test("construction with extra baseArgs still preserves --yolo", () => {
    const runner = new MockProcessRunner();
    const adapter = new GeminiAdapter(runner, {
      baseArgs: ["--timeout", "60"],
    });
    expect(adapter.contract.baseArgs).toContain("--yolo");
  });
});

// ---------------------------------------------------------------------------
// MockCLIAdapter — should be unaffected (no non-interactive policy)
// ---------------------------------------------------------------------------

describe("MockCLIAdapter is exempt from non-interactive policy", () => {
  test("constructs and runs without any non-interactive flags", async () => {
    const runner = new MockProcessRunner([{ stdout: "mock-ok" }]);
    const adapter = new MockCLIAdapter(runner);
    const result = await adapter.run({ prompt: "anything", cwd: "/tmp" });
    expect(result.stdout).toBe("mock-ok");
  });
});

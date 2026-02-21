import { describe, expect, test } from "bun:test";

import { ClaudeAdapter } from "./claude-adapter";
import { CodexAdapter } from "./codex-adapter";
import { createAdapter } from "./factory";
import { GeminiAdapter } from "./gemini-adapter";
import { MockCLIAdapter } from "./mock-adapter";
import { MockProcessRunner } from "./test-utils";

describe("CLI adapters", () => {
  test("MockCLIAdapter runs through process runner", async () => {
    const runner = new MockProcessRunner([{ stdout: "ok" }]);
    const adapter = new MockCLIAdapter(runner);

    const result = await adapter.run({
      prompt: "do something",
      cwd: "C:/repo",
    });

    expect(adapter.contract.id).toBe("MOCK_CLI");
    expect(runner.calls[0]).toEqual({
      command: "mock-cli",
      args: ["run", "do something"],
      cwd: "C:/repo",
      timeoutMs: undefined,
    });
    expect(result.stdout).toBe("ok");
  });

  test("ClaudeAdapter always includes required danger flag", async () => {
    const runner = new MockProcessRunner();
    const adapter = new ClaudeAdapter(runner, { baseArgs: ["--model", "sonnet"] });

    await adapter.run({
      prompt: "fix bug",
      cwd: "C:/repo",
    });

    expect(adapter.contract.baseArgs[0]).toBe("--print");
    expect(adapter.contract.baseArgs[1]).toBe("--dangerously-skip-permissions");
    expect(runner.calls[0]?.args).toEqual([
      "--print",
      "--dangerously-skip-permissions",
      "--model",
      "sonnet",
      "fix bug",
    ]);
  });

  test("GeminiAdapter always includes required yolo flag", async () => {
    const runner = new MockProcessRunner();
    const adapter = new GeminiAdapter(runner);

    await adapter.run({
      prompt: "write test",
      cwd: "C:/repo",
    });

    expect(adapter.contract.baseArgs[0]).toBe("--yolo");
    expect(runner.calls[0]?.args).toEqual(["--yolo", "write test"]);
  });

  test("CodexAdapter always includes sandbox bypass flag", async () => {
    const runner = new MockProcessRunner();
    const adapter = new CodexAdapter(runner);

    await adapter.run({
      prompt: "refactor module",
      cwd: "C:/repo",
    });

    expect(adapter.contract.baseArgs[0]).toBe("exec");
    expect(adapter.contract.baseArgs[1]).toBe("--dangerously-bypass-approvals-and-sandbox");
    expect(runner.calls[0]?.args).toEqual([
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "refactor module",
    ]);
  });

  test("factory creates normalized adapters", () => {
    const runner = new MockProcessRunner();

    expect(createAdapter("MOCK_CLI", runner).contract.id).toBe("MOCK_CLI");
    expect(createAdapter("CLAUDE_CLI", runner).contract.id).toBe("CLAUDE_CLI");
    expect(createAdapter("GEMINI_CLI", runner).contract.id).toBe("GEMINI_CLI");
    expect(createAdapter("CODEX_CLI", runner).contract.id).toBe("CODEX_CLI");
  });

  test("fails fast for invalid run input", async () => {
    const runner = new MockProcessRunner();
    const adapter = new CodexAdapter(runner);

    await expect(
      adapter.run({
        prompt: "",
        cwd: "C:/repo",
      })
    ).rejects.toThrow("prompt must not be empty.");

    await expect(
      adapter.run({
        prompt: "ok",
        cwd: "",
      })
    ).rejects.toThrow("cwd must not be empty.");
  });
});

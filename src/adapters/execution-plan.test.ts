import { describe, expect, test } from "bun:test";

import { buildAdapterExecutionPlan } from "./execution-plan";

describe("buildAdapterExecutionPlan", () => {
  test("uses stdin and '-' for codex normal execution", () => {
    const plan = buildAdapterExecutionPlan({
      assignee: "CODEX_CLI",
      baseArgs: ["exec"],
      prompt: "hello",
      promptFilePath: "in.txt",
      resume: false,
    });

    expect(plan.args).toEqual(["exec", "-"]);
    expect(plan.stdin).toBe("hello");
  });

  test("uses resume --last for codex retry", () => {
    const plan = buildAdapterExecutionPlan({
      assignee: "CODEX_CLI",
      baseArgs: ["exec"],
      prompt: "hello",
      promptFilePath: "in.txt",
      resume: true,
    });

    expect(plan.args).toEqual(["exec", "resume", "--last", "-"]);
    expect(plan.stdin).toBe("hello");
  });

  test("preserves explicit codex bypass flag for resume when configured", () => {
    const plan = buildAdapterExecutionPlan({
      assignee: "CODEX_CLI",
      baseArgs: ["exec", "--dangerously-bypass-approvals-and-sandbox"],
      prompt: "hello",
      promptFilePath: "in.txt",
      resume: true,
    });

    expect(plan.args).toEqual([
      "exec",
      "resume",
      "--last",
      "--dangerously-bypass-approvals-and-sandbox",
      "-",
    ]);
    expect(plan.stdin).toBe("hello");
  });

  test("uses --continue for claude retry", () => {
    const plan = buildAdapterExecutionPlan({
      assignee: "CLAUDE_CLI",
      baseArgs: ["--print", "--dangerously-skip-permissions"],
      prompt: "hello",
      promptFilePath: "in.txt",
      resume: true,
    });

    expect(plan.args).toEqual([
      "--print",
      "--dangerously-skip-permissions",
      "--continue",
    ]);
    expect(plan.stdin).toBe("hello");
  });

  test("uses --resume latest for gemini retry", () => {
    const plan = buildAdapterExecutionPlan({
      assignee: "GEMINI_CLI",
      baseArgs: ["--yolo"],
      prompt: "hello",
      promptFilePath: "in.txt",
      resume: true,
    });

    expect(plan.args).toEqual(["--yolo", "--resume", "latest", "--prompt", ""]);
    expect(plan.stdin).toBe("hello");
  });
});

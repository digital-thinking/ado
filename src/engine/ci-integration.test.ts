import { describe, expect, test } from "bun:test";

import { MockProcessRunner } from "../vcs/test-utils";
import { runCiIntegration } from "./ci-integration";

describe("runCiIntegration", () => {
  test("pushes branch and creates PR", async () => {
    const runner = new MockProcessRunner([
      { stdout: "phase-5-ci-execution-loop\n" },
      { stdout: "" },
      { stdout: "https://github.com/org/repo/pull/123\n" },
    ]);
    const setPrCalls: Array<{ phaseId: string; prUrl: string }> = [];

    const result = await runCiIntegration({
      phaseId: "11111111-1111-4111-8111-111111111111",
      phaseName: "Phase 5: CI Execution Loop",
      cwd: "C:/repo",
      baseBranch: "main",
      runner,
      setPhasePrUrl: async (input) => {
        setPrCalls.push(input);
      },
    });

    expect(result.prUrl).toBe("https://github.com/org/repo/pull/123");
    expect(result.headBranch).toBe("phase-5-ci-execution-loop");
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[0]).toEqual({
      command: "git",
      args: ["branch", "--show-current"],
      cwd: "C:/repo",
    });
    expect(runner.calls[1]).toEqual({
      command: "git",
      args: ["push", "-u", "origin", "phase-5-ci-execution-loop"],
      cwd: "C:/repo",
    });
    expect(runner.calls[2]?.command).toBe("gh");
    expect(setPrCalls).toEqual([
      {
        phaseId: "11111111-1111-4111-8111-111111111111",
        prUrl: "https://github.com/org/repo/pull/123",
      },
    ]);
  });

  test("fails fast when base branch is empty", async () => {
    const runner = new MockProcessRunner();

    await expect(
      runCiIntegration({
        phaseId: "11111111-1111-4111-8111-111111111111",
        phaseName: "Phase 5",
        cwd: "C:/repo",
        baseBranch: "   ",
        runner,
        setPhasePrUrl: async () => {},
      })
    ).rejects.toThrow("ciBaseBranch must not be empty.");
    expect(runner.calls).toHaveLength(0);
  });
});

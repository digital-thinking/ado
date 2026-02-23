import { describe, expect, test } from "bun:test";

import { OrchestrationAuthorizationDeniedError } from "../security/orchestration-authorizer";
import { MockProcessRunner } from "../vcs/test-utils";
import { runCiIntegration } from "./ci-integration";

describe("runCiIntegration", () => {
  test("pushes branch and creates PR", async () => {
    const runner = new MockProcessRunner([
      { stdout: "" },
      { stdout: "src/a.ts\n" },
      { stdout: "" },
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
      role: "admin",
      policy: {
        version: "1",
        roles: {
          owner: { allowlist: ["*"], denylist: [] },
          admin: { allowlist: ["*"], denylist: [] },
          operator: {
            allowlist: ["status:read"],
            denylist: ["git:privileged:*"],
          },
          viewer: {
            allowlist: ["status:read"],
            denylist: ["git:privileged:*"],
          },
        },
      },
      setPhasePrUrl: async (input) => {
        setPrCalls.push(input);
      },
    });

    expect(result.prUrl).toBe("https://github.com/org/repo/pull/123");
    expect(result.headBranch).toBe("phase-5-ci-execution-loop");
    expect(runner.calls).toHaveLength(6);
    expect(runner.calls[0]).toEqual({
      command: "git",
      args: ["add", "--all"],
      cwd: "C:/repo",
    });
    expect(runner.calls[1]).toEqual({
      command: "git",
      args: ["diff", "--cached", "--name-only"],
      cwd: "C:/repo",
    });
    expect(runner.calls[2]).toEqual({
      command: "git",
      args: [
        "commit",
        "-m",
        "chore(ixado): finalize Phase 5: CI Execution Loop",
      ],
      cwd: "C:/repo",
    });
    expect(runner.calls[3]).toEqual({
      command: "git",
      args: ["branch", "--show-current"],
      cwd: "C:/repo",
    });
    expect(runner.calls[4]).toEqual({
      command: "git",
      args: ["push", "-u", "origin", "phase-5-ci-execution-loop"],
      cwd: "C:/repo",
    });
    expect(runner.calls[5]?.command).toBe("gh");
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
        role: "admin",
        policy: {
          version: "1",
          roles: {
            owner: { allowlist: ["*"], denylist: [] },
            admin: { allowlist: ["*"], denylist: [] },
            operator: {
              allowlist: ["status:read"],
              denylist: ["git:privileged:*"],
            },
            viewer: {
              allowlist: ["status:read"],
              denylist: ["git:privileged:*"],
            },
          },
        },
        setPhasePrUrl: async () => {},
      }),
    ).rejects.toThrow("ciBaseBranch must not be empty.");
    expect(runner.calls).toHaveLength(0);
  });

  test("returns structured AuthorizationDenied when role lacks privileged permissions", async () => {
    const runner = new MockProcessRunner([
      { stdout: "" },
      { stdout: "src/a.ts\n" },
      { stdout: "" },
      { stdout: "phase-5-ci-execution-loop\n" },
    ]);

    const err = await runCiIntegration({
      phaseId: "11111111-1111-4111-8111-111111111111",
      phaseName: "Phase 5",
      cwd: "C:/repo",
      baseBranch: "main",
      runner,
      role: "operator",
      policy: {
        version: "1",
        roles: {
          owner: { allowlist: ["*"], denylist: [] },
          admin: { allowlist: ["*"], denylist: [] },
          operator: {
            allowlist: ["status:read"],
            denylist: ["git:privileged:*"],
          },
          viewer: {
            allowlist: ["status:read"],
            denylist: ["git:privileged:*"],
          },
        },
      },
      setPhasePrUrl: async () => {},
    }).catch((error) => error);

    expect(err).toBeInstanceOf(OrchestrationAuthorizationDeniedError);
    const denied = err as OrchestrationAuthorizationDeniedError;
    expect(denied.action).toBe("orchestrator:ci-integration:run");
    expect(denied.reason).toBe("no-allowlist-match");
    expect(runner.calls).toHaveLength(0);
  });

  test("fails fast when there is nothing to commit", async () => {
    const runner = new MockProcessRunner([{ stdout: "" }, { stdout: "" }]);

    await expect(
      runCiIntegration({
        phaseId: "11111111-1111-4111-8111-111111111111",
        phaseName: "Phase 5",
        cwd: "C:/repo",
        baseBranch: "main",
        runner,
        role: "admin",
        policy: {
          version: "1",
          roles: {
            owner: { allowlist: ["*"], denylist: [] },
            admin: { allowlist: ["*"], denylist: [] },
            operator: {
              allowlist: ["status:read"],
              denylist: ["git:privileged:*"],
            },
            viewer: {
              allowlist: ["status:read"],
              denylist: ["git:privileged:*"],
            },
          },
        },
        setPhasePrUrl: async () => {},
      }),
    ).rejects.toThrow(
      "CI integration requires a commit before push/PR, but there are no local changes to commit.",
    );
    expect(runner.calls).toHaveLength(2);
  });

  test("fails fast with actionable message when commit command fails", async () => {
    const runner = new MockProcessRunner([
      { stdout: "" },
      { stdout: "src/a.ts\n" },
      new Error("hooks rejected commit"),
    ]);

    await expect(
      runCiIntegration({
        phaseId: "11111111-1111-4111-8111-111111111111",
        phaseName: "Phase 5",
        cwd: "C:/repo",
        baseBranch: "main",
        runner,
        role: "admin",
        policy: {
          version: "1",
          roles: {
            owner: { allowlist: ["*"], denylist: [] },
            admin: { allowlist: ["*"], denylist: [] },
            operator: {
              allowlist: ["status:read"],
              denylist: ["git:privileged:*"],
            },
            viewer: {
              allowlist: ["status:read"],
              denylist: ["git:privileged:*"],
            },
          },
        },
        setPhasePrUrl: async () => {},
      }),
    ).rejects.toThrow(
      "CI integration could not create commit before push/PR: hooks rejected commit",
    );
    expect(runner.calls).toHaveLength(3);
  });
});

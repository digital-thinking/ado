import { describe, expect, test } from "bun:test";

import { OrchestrationAuthorizationDeniedError } from "../security/orchestration-authorizer";
import { MockProcessRunner } from "../vcs/test-utils";
import { runCiIntegration } from "./ci-integration";

const DEFAULT_PULL_REQUEST_SETTINGS = {
  defaultTemplatePath: null,
  templateMappings: [],
  labels: [],
  assignees: [],
  createAsDraft: false,
  markReadyOnApproval: false,
};

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
      pullRequest: DEFAULT_PULL_REQUEST_SETTINGS,
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
    expect(runner.calls[5]?.args).toEqual([
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      "phase-5-ci-execution-loop",
      "--title",
      "Phase 5: CI Execution Loop",
      "--body",
      "Automated PR created by IxADO for Phase 5: CI Execution Loop.",
    ]);
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
        pullRequest: DEFAULT_PULL_REQUEST_SETTINGS,
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
      pullRequest: DEFAULT_PULL_REQUEST_SETTINGS,
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
        pullRequest: DEFAULT_PULL_REQUEST_SETTINGS,
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
        pullRequest: DEFAULT_PULL_REQUEST_SETTINGS,
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

  test("applies configured template mapping, labels, assignees, and draft mode", async () => {
    const runner = new MockProcessRunner([
      { stdout: "" },
      { stdout: "src/a.ts\n" },
      { stdout: "" },
      { stdout: "phase-23-feature\n" },
      { stdout: "" },
      { stdout: "https://github.com/org/repo/pull/321\n" },
    ]);

    await runCiIntegration({
      phaseId: "11111111-1111-4111-8111-111111111111",
      phaseName: "Phase 23",
      cwd: "C:/repo",
      baseBranch: "main",
      pullRequest: {
        defaultTemplatePath: ".github/pull_request_template.md",
        templateMappings: [
          {
            branchPrefix: "phase-23-",
            templatePath: ".github/pull_request_template_phase23.md",
          },
        ],
        labels: ["ixado", "phase-23"],
        assignees: ["octocat"],
        createAsDraft: true,
        markReadyOnApproval: false,
      },
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
    });

    expect(runner.calls[5]?.args).toEqual([
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      "phase-23-feature",
      "--title",
      "Phase 23",
      "--body",
      "Automated PR created by IxADO for Phase 23.",
      "--template",
      ".github/pull_request_template_phase23.md",
      "--label",
      "ixado,phase-23",
      "--assignee",
      "octocat",
      "--draft",
    ]);
  });
});

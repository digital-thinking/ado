import { describe, expect, test } from "bun:test";

import { OrchestrationAuthorizationDeniedError } from "../security/orchestration-authorizer";
import { MockProcessRunner } from "../vcs/test-utils";
import { derivePullRequestMetadata, runCiIntegration } from "./ci-integration";
import { type Task } from "../types";

const DEFAULT_PULL_REQUEST_SETTINGS = {
  defaultTemplatePath: null,
  templateMappings: [],
  labels: [],
  assignees: [],
  createAsDraft: false,
  markReadyOnApproval: false,
};

describe("derivePullRequestMetadata", () => {
  test("formats title and body with DONE tasks sorted by ID and excludes CI_FIX", () => {
    const tasks: Task[] = [
      {
        id: "t2",
        title: "Task 2",
        description: "Desc 2",
        status: "CI_FIX",
        assignee: "UNASSIGNED",
        dependencies: [],
      },
      {
        id: "t1",
        title: "Task 1",
        description: "Desc 1",
        status: "DONE",
        assignee: "UNASSIGNED",
        dependencies: [],
      },
      {
        id: "t3",
        title: "Task 3",
        description: "Desc 3",
        status: "TODO",
        assignee: "UNASSIGNED",
        dependencies: [],
      },
    ];

    const { title, body } = derivePullRequestMetadata("Phase 1", tasks);

    expect(title).toBe("Phase 1");
    expect(body).toContain("## Phase: Phase 1");
    expect(body).toContain("### Completed Tasks");
    expect(body).toContain("- **Task 1**: Desc 1");
    expect(body).not.toContain("Task 2");
    expect(body).not.toContain("Task 3");
    expect(body).toContain(
      "*Automated PR created by [IxADO](https://github.com/digital-thinking/ado).*",
    );
  });

  test("handles empty tasks", () => {
    const { body } = derivePullRequestMetadata("Phase 1", []);
    expect(body).toContain("_No tasks recorded._");
  });

  test("truncates long title but keeps full name in body", () => {
    const longName = "A".repeat(300);
    const tasks: Task[] = [
      {
        id: "t1",
        title: "Task 1",
        description: "Desc 1",
        status: "DONE",
        assignee: "UNASSIGNED",
        dependencies: [],
      },
    ];

    const { title, body } = derivePullRequestMetadata(longName, tasks);
    expect(title.length).toBeLessThanOrEqual(250);
    expect(title).toMatch(/\.\.\.$/);
    expect(body).toContain(`## Phase: ${longName}`);
  });

  test("replaces newlines with spaces in title", () => {
    const nameWithNewlines = "Phase 1\nSubtitle\r\nMore";
    const { title } = derivePullRequestMetadata(nameWithNewlines, []);
    expect(title).toBe("Phase 1 Subtitle More");
  });

  test("truncates long body", () => {
    const tasks: Task[] = Array.from({ length: 1000 }).map((_, i) => ({
      id: `t${i.toString().padStart(4, "0")}`,
      title: `Task ${i}`,
      description: "D".repeat(100),
      status: "DONE",
      assignee: "UNASSIGNED",
      dependencies: [],
    }));

    const { body } = derivePullRequestMetadata("Phase 1", tasks);
    expect(body.length).toBeLessThanOrEqual(60000);
    expect(body).toMatch(/\.\.\. \(body truncated\)$/);
  });
});

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

    const tasks: Task[] = [
      {
        id: "t1",
        title: "Task 1",
        description: "Desc 1",
        status: "DONE",
        assignee: "UNASSIGNED",
        dependencies: [],
      },
    ];

    const result = await runCiIntegration({
      phaseId: "11111111-1111-4111-8111-111111111111",
      phaseName: "Phase 5: CI Execution Loop",
      tasks,
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
    const ghArgs = runner.calls[5]?.args as string[];
    expect(ghArgs[0]).toBe("pr");
    expect(ghArgs[1]).toBe("create");
    expect(ghArgs[7]).toBe("Phase 5: CI Execution Loop");
    expect(ghArgs[9]).toContain("## Phase: Phase 5: CI Execution Loop");
    expect(ghArgs[9]).toContain("- **Task 1**: Desc 1");

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
        tasks: [],
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
      tasks: [],
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
        tasks: [],
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
        tasks: [],
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
      tasks: [],
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

    const ghArgs = runner.calls[5]?.args as string[];
    expect(ghArgs[0]).toBe("pr");
    expect(ghArgs[1]).toBe("create");
    expect(ghArgs[7]).toBe("Phase 23");
    expect(ghArgs[9]).toContain("## Phase: Phase 23");
    expect(ghArgs).toContain("--template");
    expect(ghArgs).toContain(".github/pull_request_template_phase23.md");
    expect(ghArgs).toContain("--label");
    expect(ghArgs).toContain("ixado,phase-23");
    expect(ghArgs).toContain("--assignee");
    expect(ghArgs).toContain("octocat");
    expect(ghArgs).toContain("--draft");
  });
});

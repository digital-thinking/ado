import { describe, expect, mock, test } from "bun:test";

import { PhaseRunner, type PhaseRunnerConfig } from "./phase-runner";
import { DEFAULT_AUTH_POLICY } from "../security/policy";
import type { ProcessRunner } from "../process";
import type { ControlCenterService } from "../web";
import {
  createTelegramNotificationEvaluator,
  formatRuntimeEventForTelegram,
  type RuntimeEvent,
} from "../types/runtime-events";

function createBaseConfig(): PhaseRunnerConfig {
  return {
    mode: "AUTO",
    countdownSeconds: 0,
    activeAssignee: "CODEX_CLI",
    maxRecoveryAttempts: 1,
    testerCommand: null,
    testerArgs: null,
    testerTimeoutMs: 1_000,
    vcsProvider: "github" as const,
    gates: [{ type: "pr_ci" }],
    ciBaseBranch: "main",
    ciPullRequest: {
      defaultTemplatePath: ".github/pull_request_template.md",
      templateMappings: [],
      labels: [],
      assignees: [],
      createAsDraft: false,
      markReadyOnApproval: false,
    },
    ciFixMaxDepth: 3,
    projectRootDir: "/tmp/project",
    projectName: "test-project",
    policy: DEFAULT_AUTH_POLICY,
    role: "admin",
  };
}

function toTelegramMessages(
  events: RuntimeEvent[],
  level: "all" | "important" | "critical",
): string[] {
  const shouldNotify = createTelegramNotificationEvaluator({
    level,
    suppressDuplicates: true,
  });

  return events
    .filter((event) => shouldNotify(event))
    .map((event) => formatRuntimeEventForTelegram(event));
}

describe("P23-006 integration coverage", () => {
  test("PR automation flow emits expected GH arguments, lifecycle payloads, and Telegram-critical messages", async () => {
    const phaseId = "51111111-1111-4111-8111-111111111111";
    const taskId = "52222222-2222-4222-8222-222222222222";
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 23 PR Automation",
          branchName: "phase-23-pr-automation",
          status: "PLANNING",
          prUrl: undefined as string | undefined,
          tasks: [
            {
              id: taskId,
              title: "P23-006 PR automation",
              description: "Validate PR automation integration",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
          ],
        },
      ],
    };

    const control = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => state),
      setPhaseStatus: mock(async (input: { status: string }) => {
        state.phases[0].status = input.status as any;
        return state;
      }),
      setPhasePrUrl: mock(async (input: { prUrl: string }) => {
        state.phases[0].prUrl = input.prUrl;
        return state;
      }),
      startActiveTaskAndWait: mock(async (input: { taskNumber: number }) => {
        const task = state.phases[0].tasks[input.taskNumber - 1];
        if (task) {
          task.status = "DONE";
        }
        return state;
      }),
      createTask: mock(async () => state),
      recordRecoveryAttempt: mock(async () => state),
      runInternalWork: mock(async () => ({ stdout: "", stderr: "" })),
    } as unknown as ControlCenterService;

    let ciViewCalls = 0;
    const runner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.command === "git" && input.args.includes("--porcelain")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (
          input.command === "git" &&
          input.args.includes("branch") &&
          input.args.includes("--show-current")
        ) {
          return {
            exitCode: 0,
            stdout: "phase-23-pr-automation\n",
            stderr: "",
          };
        }
        if (
          input.command === "git" &&
          input.args.includes("--cached") &&
          input.args.includes("--name-only")
        ) {
          return { exitCode: 0, stdout: "src/a.ts\n", stderr: "" };
        }
        if (
          input.command === "git" &&
          input.args.includes("diff") &&
          input.args.includes("--no-color")
        ) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (
          input.command === "gh" &&
          input.args[0] === "pr" &&
          input.args[1] === "create"
        ) {
          return {
            exitCode: 0,
            stdout: "https://github.com/org/repo/pull/2306\n",
            stderr: "",
          };
        }
        if (
          input.command === "gh" &&
          input.args[0] === "pr" &&
          input.args[1] === "view" &&
          input.args.includes("statusCheckRollup")
        ) {
          ciViewCalls += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              statusCheckRollup: [
                {
                  name: "build",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
              ],
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const events: RuntimeEvent[] = [];
    const phaseRunner = new PhaseRunner(
      control,
      {
        ...createBaseConfig(),
        ciPullRequest: {
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
          markReadyOnApproval: true,
        },
      },
      undefined,
      async (event) => {
        events.push(event);
      },
      runner,
    );

    await phaseRunner.run();

    expect(ciViewCalls).toBeGreaterThanOrEqual(2);

    const ghCalls = (runner.run as ReturnType<typeof mock>).mock.calls
      .map((entry: any[]) => entry[0])
      .filter((call: any) => call.command === "gh");
    const createCall = ghCalls.find(
      (call: any) => call.args[0] === "pr" && call.args[1] === "create",
    );
    expect(createCall).toBeDefined();
    expect(createCall.args).toContain("--template");
    expect(createCall.args).toContain(
      ".github/pull_request_template_phase23.md",
    );
    expect(createCall.args).toContain("--label");
    expect(createCall.args).toContain("ixado,phase-23");
    expect(createCall.args).toContain("--assignee");
    expect(createCall.args).toContain("octocat");
    expect(createCall.args).toContain("--draft");

    const readyCall = ghCalls.find(
      (call: any) => call.args[0] === "pr" && call.args[1] === "ready",
    );
    expect(readyCall).toBeDefined();
    expect(readyCall.args).toEqual(["pr", "ready", "2306"]);

    const prCreated = events.find(
      (event) =>
        event.type === "pr.activity" && event.payload.stage === "created",
    );
    expect(prCreated).toBeDefined();
    if (!prCreated || prCreated.type !== "pr.activity") {
      throw new Error("Expected pr.activity created event.");
    }
    expect(prCreated.payload.draft).toBe(true);
    expect(prCreated.payload.baseBranch).toBe("main");
    expect(prCreated.payload.headBranch).toBe("phase-23-pr-automation");

    const prReady = events.find(
      (event) =>
        event.type === "pr.activity" &&
        event.payload.stage === "ready-for-review",
    );
    expect(prReady).toBeDefined();

    const criticalMessages = toTelegramMessages(events, "critical");
    expect(criticalMessages).toContain(
      "Phase update: Phase 23 PR Automation -> CREATING_PR.",
    );
    expect(
      criticalMessages.some((message) =>
        message.includes(
          "PR: Created PR #2306: https://github.com/org/repo/pull/2306",
        ),
      ),
    ).toBe(true);
    expect(
      criticalMessages.some((message) =>
        message.includes("PR: Marked PR #2306 as ready for review."),
      ),
    ).toBe(true);
    expect(
      criticalMessages.some((message) =>
        message.includes(
          "Outcome: Phase Phase 23 PR Automation passed all gates and is ready for review.",
        ),
      ),
    ).toBe(true);
    const importantMessages = toTelegramMessages(events, "important");
    expect(
      importantMessages.some((message) =>
        message.includes('Gate: Gate "pr_ci" passed (1/1).'),
      ),
    ).toBe(true);
  });
});

describe("P25-005 integration coverage", () => {
  test("terminal phase with actionable tasks resumes execution instead of failing preflight", async () => {
    const phaseId = "53333333-3333-4333-8333-333333333333";
    const taskId = "54444444-4444-4444-8444-444444444444";
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 25 Resumable",
          branchName: "phase-25-resumable",
          status: "DONE",
          tasks: [
            {
              id: taskId,
              title: "Continue from terminal phase",
              description: "Task added after terminal phase status",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
          ],
        },
      ],
    };

    const control = {
      reconcileInProgressTasks: mock(async () => 0),
      getState: mock(async () => state),
      setPhaseStatus: mock(async (input: { status: string }) => {
        state.phases[0].status = input.status as any;
        return state;
      }),
      startActiveTaskAndWait: mock(async (input: { taskNumber: number }) => {
        const task = state.phases[0].tasks[input.taskNumber - 1];
        if (task) {
          task.status = "DONE";
        }
        return state;
      }),
      createTask: mock(async () => state),
      recordRecoveryAttempt: mock(async () => state),
      runInternalWork: mock(async () => ({ stdout: "", stderr: "" })),
    } as unknown as ControlCenterService;

    const runner: ProcessRunner = {
      run: mock(async (input: any) => {
        if (input.command === "git" && input.args.includes("--porcelain")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (
          input.command === "git" &&
          input.args.includes("branch") &&
          input.args.includes("--show-current")
        ) {
          return {
            exitCode: 0,
            stdout: "phase-25-resumable\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    } as any;

    const events: RuntimeEvent[] = [];
    const phaseRunner = new PhaseRunner(
      control,
      {
        ...createBaseConfig(),
        vcsProvider: "null" as const,
      },
      undefined,
      async (event) => {
        events.push(event);
      },
      runner,
    );

    await expect(phaseRunner.run()).resolves.toBeUndefined();
    expect(control.startActiveTaskAndWait).toHaveBeenCalledWith({
      taskNumber: 1,
      assignee: "CODEX_CLI",
      resolvedAssignee: "CODEX_CLI",
      routingReason: "fallback",
      resume: false,
    });

    const statusCalls = (control.setPhaseStatus as ReturnType<typeof mock>).mock
      .calls;
    const toStatuses = statusCalls
      .map((entry: any[]) => entry[0]?.status)
      .filter(
        (status: unknown): status is string => typeof status === "string",
      );
    expect(toStatuses).toContain("BRANCHING");
    expect(toStatuses[toStatuses.length - 1]).toBe("DONE");

    const terminalOutcome = events.find(
      (event) => event.type === "terminal.outcome",
    );
    expect(terminalOutcome).toBeDefined();
    if (!terminalOutcome || terminalOutcome.type !== "terminal.outcome") {
      throw new Error("Expected terminal.outcome event.");
    }
    expect(terminalOutcome.payload.outcome).toBe("success");
  });
});

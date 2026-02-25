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
    ciEnabled: true,
    ciBaseBranch: "main",
    ciPullRequest: {
      defaultTemplatePath: ".github/pull_request_template.md",
      templateMappings: [],
      labels: [],
      assignees: [],
      createAsDraft: false,
      markReadyOnApproval: false,
    },
    validationMaxRetries: 1,
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
      activePhaseId: phaseId,
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
        message.includes("CI: CI checks and review approved for PR #2306."),
      ),
    ).toBe(true);
    expect(
      criticalMessages.some((message) =>
        message.includes("Outcome: Review approved after 0 round(s)."),
      ),
    ).toBe(true);
    expect(
      criticalMessages.some((message) => message.includes("CI transition")),
    ).toBe(false);
  });

  test("CI mapping flow creates targeted CI_FIX tasks, records skip counts, and emits failure notifications", async () => {
    const phaseId = "61111111-1111-4111-8111-111111111111";
    const taskId = "62222222-2222-4222-8222-222222222222";
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseId: phaseId,
      phases: [
        {
          id: phaseId,
          name: "Phase 23 CI Mapping",
          branchName: "phase-23-ci-mapping",
          status: "PLANNING",
          prUrl: undefined as string | undefined,
          tasks: [
            {
              id: taskId,
              title: "P23-006 CI mapping",
              description: "Validate CI mapping and dedup",
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
      setPhaseStatus: mock(
        async (input: { status: string; ciStatusContext?: string }) => {
          state.phases[0].status = input.status as any;
          if (typeof input.ciStatusContext === "string") {
            (state.phases[0] as any).ciStatusContext = input.ciStatusContext;
          }
          return state;
        },
      ),
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
      createTask: mock(async (input: any) => {
        state.phases[0].tasks.push({
          id: `${state.phases[0].tasks.length + 1}`,
          title: input.title,
          description: input.description,
          status: input.status,
          assignee: input.assignee,
          dependencies: input.dependencies,
        });
        return state;
      }),
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
          return { exitCode: 0, stdout: "phase-23-ci-mapping\n", stderr: "" };
        }
        if (
          input.command === "git" &&
          input.args.includes("--cached") &&
          input.args.includes("--name-only")
        ) {
          return { exitCode: 0, stdout: "src/a.ts\n", stderr: "" };
        }
        if (
          input.command === "gh" &&
          input.args[0] === "pr" &&
          input.args[1] === "create"
        ) {
          return {
            exitCode: 0,
            stdout: "https://github.com/org/repo/pull/2307\n",
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
                  name: "lint",
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                  detailsUrl: "https://ci.example/lint",
                },
                {
                  name: "lint",
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                },
                {
                  name: "unit tests",
                  status: "COMPLETED",
                  conclusion: "FAILURE",
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
      createBaseConfig(),
      undefined,
      async (event) => {
        events.push(event);
      },
      runner,
    );

    await expect(phaseRunner.run()).rejects.toThrow(
      "Execution loop stopped after CI checks failed. Targeted CI_FIX tasks are pending.",
    );

    expect(ciViewCalls).toBeGreaterThanOrEqual(2);

    const createTaskCalls = (control.createTask as ReturnType<typeof mock>).mock
      .calls;
    expect(createTaskCalls).toHaveLength(2);
    expect(createTaskCalls[0]?.[0].title).toBe("CI_FIX: lint");
    expect(createTaskCalls[1]?.[0].title).toBe("CI_FIX: unit tests");

    const ciFailedCall = (
      control.setPhaseStatus as ReturnType<typeof mock>
    ).mock.calls
      .map((entry: any[]) => entry[0])
      .find((call: any) => call.status === "CI_FAILED");
    expect(ciFailedCall).toBeDefined();
    expect(ciFailedCall.ciStatusContext).toContain(
      "CI_FIX mapping: created=2, skipped_existing=1",
    );

    const failedEvent = events.find(
      (event) =>
        event.type === "ci.activity" && event.payload.stage === "failed",
    );
    expect(failedEvent).toBeDefined();
    if (!failedEvent || failedEvent.type !== "ci.activity") {
      throw new Error("Expected ci.activity failed event.");
    }
    expect(failedEvent.payload.createdFixTaskCount).toBe(2);
    expect(failedEvent.payload.overall).toBe("FAILURE");

    const criticalMessages = toTelegramMessages(events, "critical");
    expect(
      criticalMessages.some((message) =>
        message.includes(
          "CI: CI checks failed for PR #2307; created 2 CI_FIX task(s).",
        ),
      ),
    ).toBe(true);
    expect(
      criticalMessages.some((message) =>
        message.includes(
          "Outcome: CI checks failed for PR #2307; created 2 CI_FIX task(s).",
        ),
      ),
    ).toBe(true);
  });

  test("CI validation retry flow converges after fixer pass and Telegram-important messages stay focused", async () => {
    const phaseId = "71111111-1111-4111-8111-111111111111";
    const taskId = "72222222-2222-4222-8222-222222222222";
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseId: phaseId,
      phases: [
        {
          id: phaseId,
          name: "Phase 23 CI Retry",
          branchName: "phase-23-ci-retry",
          status: "PLANNING",
          prUrl: undefined as string | undefined,
          tasks: [
            {
              id: taskId,
              title: "P23-006 CI retry",
              description: "Validate CI validation retry flow",
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
            },
          ],
        },
      ],
    };

    let reviewerCalls = 0;
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
      runInternalWork: mock(async (input: { prompt: string }) => {
        if (input.prompt.includes("Worker archetype: REVIEWER")) {
          reviewerCalls += 1;
          if (reviewerCalls === 1) {
            return {
              stdout:
                '{"verdict":"CHANGES_REQUESTED","comments":["Add regression test for CI edge case"]}',
              stderr: "",
            };
          }
          return {
            stdout: '{"verdict":"APPROVED","comments":[]}',
            stderr: "",
          };
        }

        return {
          stdout: "Applied targeted fix and reran tests.",
          stderr: "",
        };
      }),
    } as unknown as ControlCenterService;

    let ciViewCalls = 0;
    let diffCalls = 0;
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
          return { exitCode: 0, stdout: "phase-23-ci-retry\n", stderr: "" };
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
          diffCalls += 1;
          return {
            exitCode: 0,
            stdout: "diff --git a/src/a.ts b/src/a.ts\n+fix",
            stderr: "",
          };
        }
        if (
          input.command === "gh" &&
          input.args[0] === "pr" &&
          input.args[1] === "create"
        ) {
          return {
            exitCode: 0,
            stdout: "https://github.com/org/repo/pull/2308\n",
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
        validationMaxRetries: 2,
      },
      undefined,
      async (event) => {
        events.push(event);
      },
      runner,
    );

    await phaseRunner.run();

    expect(ciViewCalls).toBeGreaterThanOrEqual(2);
    expect(diffCalls).toBe(2);
    expect(reviewerCalls).toBe(2);

    const maxRetryEvent = events.find(
      (event) =>
        event.type === "ci.activity" &&
        event.payload.stage === "validation-max-retries",
    );
    expect(maxRetryEvent).toBeUndefined();

    const successEvent = events.find(
      (event) =>
        event.type === "ci.activity" && event.payload.stage === "succeeded",
    );
    expect(successEvent).toBeDefined();
    if (!successEvent || successEvent.type !== "ci.activity") {
      throw new Error("Expected ci.activity succeeded event.");
    }
    expect(successEvent.payload.summary).toBe(
      "CI checks and review approved for PR #2308.",
    );

    const importantMessages = toTelegramMessages(events, "important");
    expect(
      importantMessages.some((message) =>
        message.includes("CI: CI checks and review approved for PR #2308."),
      ),
    ).toBe(true);
    expect(
      importantMessages.some((message) =>
        message.includes("Outcome: Review approved after 2 round(s)."),
      ),
    ).toBe(true);
    expect(
      importantMessages.some((message) => message.includes("CI transition")),
    ).toBe(false);
  });
});

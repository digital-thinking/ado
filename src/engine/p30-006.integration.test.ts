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
    vcsProvider: "github" as const,
    gates: [],
    ciBaseBranch: "main",
    ciPullRequest: {
      defaultTemplatePath: null,
      templateMappings: [],
      labels: [],
      assignees: [],
      createAsDraft: false,
      markReadyOnApproval: false,
    },
    validationMaxRetries: 1,
    ciFixMaxFanOut: 10,
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

describe("P30-006 integration coverage", () => {
  test("deliberation execution hands off refined prompt and surfaces PR/Telegram summaries", async () => {
    const phaseId = "81111111-1111-4111-8111-111111111111";
    const taskId = "82222222-2222-4222-8222-222222222222";
    const state = {
      projectName: "test-project",
      rootDir: "/tmp/project",
      activePhaseIds: [phaseId],
      phases: [
        {
          id: phaseId,
          name: "Phase 30 Deliberation",
          branchName: "phase-30-deliberation-mode",
          status: "PLANNING",
          prUrl: undefined as string | undefined,
          tasks: [
            {
              id: taskId,
              title: "Build deliberation runner",
              description: "Ship deliberation mode with summary surfaces",
              deliberate: true,
              status: "TODO",
              assignee: "UNASSIGNED",
              dependencies: [],
              resultContext: undefined as string | undefined,
            },
          ],
        },
      ],
    };

    const startInputs: any[] = [];
    const internalCalls: Array<{ assignee: string; prompt: string }> = [];
    let critiqueRound = 0;
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
      startActiveTaskAndWait: mock(async (input: any) => {
        startInputs.push(input);
        const task = state.phases[0].tasks[0];
        if (task) {
          task.status = "DONE";
          task.resultContext = [input.resultContextPrefix, "Task completed."]
            .filter((line) => Boolean(line))
            .join("\n\n");
        }
        return state;
      }),
      createTask: mock(async () => state),
      recordRecoveryAttempt: mock(async () => state),
      runInternalWork: mock(
        async (input: { assignee: string; prompt: string }) => {
          internalCalls.push({
            assignee: input.assignee,
            prompt: input.prompt,
          });
          if (input.prompt.includes("Deliberation Stage: PROPOSE")) {
            return {
              stdout: '{"proposal":"Initial prompt with missing verification"}',
              stderr: "",
            };
          }
          if (input.prompt.includes("Deliberation Stage: REFINE")) {
            return {
              stdout:
                '{"proposal":"Refined prompt with explicit validation commands."}',
              stderr: "",
            };
          }
          if (input.prompt.includes("Deliberation Stage: CRITIQUE")) {
            critiqueRound += 1;
            if (critiqueRound === 1) {
              return {
                stdout:
                  '{"verdict":"CHANGES_REQUESTED","comments":["Add concrete validation command evidence."]}',
                stderr: "",
              };
            }
            return {
              stdout: '{"verdict":"APPROVED","comments":[]}',
              stderr: "",
            };
          }
          if (input.prompt.includes("Worker archetype: REVIEWER")) {
            return {
              stdout: '{"verdict":"APPROVED","comments":[]}',
              stderr: "",
            };
          }
          return { stdout: "", stderr: "" };
        },
      ),
    } as unknown as ControlCenterService;

    let ciPollCalls = 0;
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
            stdout: "phase-30-deliberation-mode\n",
            stderr: "",
          };
        }
        if (
          input.command === "git" &&
          input.args.includes("--cached") &&
          input.args.includes("--name-only")
        ) {
          return {
            exitCode: 0,
            stdout: "src/engine/deliberation-pass.ts\n",
            stderr: "",
          };
        }
        if (
          input.command === "git" &&
          input.args.includes("diff") &&
          input.args.includes("--no-color")
        ) {
          return {
            exitCode: 0,
            stdout:
              "diff --git a/src/engine/deliberation-pass.ts b/src/engine/deliberation-pass.ts",
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
            stdout: "https://github.com/org/repo/pull/3030\n",
            stderr: "",
          };
        }
        if (
          input.command === "gh" &&
          input.args[0] === "pr" &&
          input.args[1] === "view" &&
          input.args.includes("statusCheckRollup")
        ) {
          ciPollCalls += 1;
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
        deliberation: {
          reviewerAdapter: "CLAUDE_CLI",
          maxRefinePasses: 2,
        },
      },
      undefined,
      async (event) => {
        events.push(event);
      },
      runner,
    );

    await phaseRunner.run();

    expect(ciPollCalls).toBeGreaterThanOrEqual(2);
    expect(startInputs).toHaveLength(1);
    expect(startInputs[0]?.taskDescriptionOverride).toBe(
      "Refined prompt with explicit validation commands.",
    );

    const deliberationPrompts = internalCalls
      .map((call) => call.prompt)
      .filter((prompt) => prompt.includes("Deliberation Stage:"));
    expect(deliberationPrompts).toHaveLength(4);
    expect(
      internalCalls.some(
        (call) =>
          call.assignee === "CLAUDE_CLI" &&
          call.prompt.includes("Deliberation Stage: CRITIQUE"),
      ),
    ).toBe(true);

    const ghCalls = (runner.run as ReturnType<typeof mock>).mock.calls
      .map((entry: any[]) => entry[0])
      .filter((call: any) => call.command === "gh");
    const createCall = ghCalls.find(
      (call: any) => call.args[0] === "pr" && call.args[1] === "create",
    );
    expect(createCall).toBeDefined();
    const bodyIndex = createCall.args.indexOf("--body");
    expect(bodyIndex).toBeGreaterThan(-1);
    const prBody = createCall.args[bodyIndex + 1];
    expect(prBody).toContain("### Deliberation");
    expect(prBody).toContain(
      "| Build deliberation runner | APPROVED | 2 | 1/2 | 0 |",
    );

    const importantMessages = toTelegramMessages(events, "important");
    expect(
      importantMessages.some((message) =>
        message.includes(
          "Deliberation: APPROVED (rounds=2, refinePasses=1, pendingComments=0).",
        ),
      ),
    ).toBe(true);
    expect(
      importantMessages.some((message) =>
        message.includes(
          "PR: Created PR #3030: https://github.com/org/repo/pull/3030",
        ),
      ),
    ).toBe(true);
  });
});

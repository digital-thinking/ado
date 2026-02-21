import { describe, expect, test } from "bun:test";

import type { ProcessRunResult, ProcessRunner } from "../process";
import type { CLIAdapter, ProjectState } from "../types";
import type { CiStatusSummary } from "../vcs";
import {
  type AdapterFactory,
  type GitHubOps,
  type GitOps,
  type NotificationPublisherLike,
  PhaseExecutionEngine,
  type StateStore,
  type UsageTrackerLike,
} from "./phase-execution-engine";

class InMemoryStateStore implements StateStore {
  private state: ProjectState;

  constructor(state: ProjectState) {
    this.state = JSON.parse(JSON.stringify(state)) as ProjectState;
  }

  async readProjectState(): Promise<ProjectState> {
    return JSON.parse(JSON.stringify(this.state)) as ProjectState;
  }

  async writeProjectState(state: ProjectState): Promise<ProjectState> {
    this.state = JSON.parse(JSON.stringify(state)) as ProjectState;
    return this.readProjectState();
  }
}

class MockGit implements GitOps {
  readonly createBranchCalls: Array<{ branchName: string; cwd: string; fromRef?: string }> = [];
  readonly pushCalls: Array<{ branchName: string; cwd: string; remote?: string; setUpstream?: boolean }> = [];
  ensureCleanCalls = 0;

  async ensureCleanWorkingTree(): Promise<void> {
    this.ensureCleanCalls += 1;
  }

  async createBranch(input: { branchName: string; cwd: string; fromRef?: string }): Promise<void> {
    this.createBranchCalls.push(input);
  }

  async pushBranch(input: {
    branchName: string;
    cwd: string;
    remote?: string;
    setUpstream?: boolean;
  }): Promise<void> {
    this.pushCalls.push(input);
  }
}

class MockGitHub implements GitHubOps {
  readonly createPullRequestCalls: Array<{
    base: string;
    head: string;
    title: string;
    body: string;
    cwd: string;
  }> = [];
  readonly reviewCalls: Array<{ prNumber: number; body: string; cwd: string }> = [];
  private readonly statuses: CiStatusSummary[];

  constructor(statuses: CiStatusSummary[]) {
    this.statuses = [...statuses];
  }

  async createPullRequest(input: {
    base: string;
    head: string;
    title: string;
    body: string;
    cwd: string;
  }): Promise<string> {
    this.createPullRequestCalls.push(input);
    return "https://github.com/org/repo/pull/99";
  }

  async pollCiStatus(): Promise<CiStatusSummary> {
    const next = this.statuses.shift();
    if (!next) {
      throw new Error("No more mocked CI statuses.");
    }

    return next;
  }

  async addReviewComment(prNumber: number, body: string, cwd: string): Promise<void> {
    this.reviewCalls.push({ prNumber, body, cwd });
  }
}

class MockNotifier implements NotificationPublisherLike {
  readonly messages: string[] = [];

  async notify(message: string): Promise<void> {
    this.messages.push(message);
  }
}

class MockUsageTracker implements UsageTrackerLike {
  private readonly payload: unknown;

  constructor(payload: unknown) {
    this.payload = payload;
  }

  async collect(): Promise<{ capturedAt: string; payload: unknown; raw: string }> {
    return {
      capturedAt: new Date().toISOString(),
      payload: this.payload,
      raw: JSON.stringify(this.payload),
    };
  }
}

type MockAdapterResult = ProcessRunResult | Error;

function createAdapterFactory(results: MockAdapterResult[], chosenAssignees: string[]): AdapterFactory {
  return (adapterId): {
    readonly id: "MOCK_CLI" | "CLAUDE_CLI" | "GEMINI_CLI" | "CODEX_CLI";
    readonly contract: CLIAdapter;
    run: () => Promise<ProcessRunResult>;
  } => {
    chosenAssignees.push(adapterId);

    return {
      id: adapterId,
      contract: {
        id: adapterId,
        command: "mock",
        baseArgs: [],
      },
      run: async () => {
        const next = results.shift();
        if (!next) {
          throw new Error("No mocked adapter result available.");
        }

        if (next instanceof Error) {
          throw next;
        }

        return next;
      },
    };
  };
}

function createRunner(): ProcessRunner {
  return {
    async run() {
      throw new Error("Runner should not be used directly in integration test.");
    },
  };
}

function createPhaseState(): ProjectState {
  return {
    projectName: "IxADO",
    rootDir: "C:/repo",
    phases: [
      {
        id: "11111111-1111-1111-1111-111111111111",
        name: "Phase 5",
        branchName: "phase-5-ci-execution-loop",
        status: "PLANNING",
        tasks: [
          {
            id: "22222222-2222-2222-2222-222222222222",
            title: "Task 1",
            description: "Run first task",
            status: "TODO",
            assignee: "UNASSIGNED",
            dependencies: [],
          },
          {
            id: "33333333-3333-3333-3333-333333333333",
            title: "Task 2",
            description: "Run second task",
            status: "TODO",
            assignee: "UNASSIGNED",
            dependencies: ["22222222-2222-2222-2222-222222222222"],
          },
        ],
      },
    ],
    activePhaseId: "11111111-1111-1111-1111-111111111111",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function successResult(stdout: string): ProcessRunResult {
  return {
    command: "mock",
    args: [],
    cwd: "C:/repo",
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    durationMs: 1,
  };
}

describe("PhaseExecutionEngine integration", () => {
  test("runs phase end-to-end and reaches READY_FOR_REVIEW on green CI", async () => {
    const store = new InMemoryStateStore(createPhaseState());
    const git = new MockGit();
    const github = new MockGitHub([{ overall: "SUCCESS", checks: [] }]);
    const notifier = new MockNotifier();
    const chosenAssignees: string[] = [];
    const adapterFactory = createAdapterFactory([successResult("task1"), successResult("task2")], chosenAssignees);

    const engine = new PhaseExecutionEngine({
      store,
      git,
      github,
      runner: createRunner(),
      adapterFactory,
      notifier,
    });

    const result = await engine.runPhase("11111111-1111-1111-1111-111111111111", {
      cwd: "C:/repo",
      baseBranch: "main",
      availableAssignees: ["MOCK_CLI"],
    });

    const phase = (await store.readProjectState()).phases[0];
    expect(result.prUrl).toBe("https://github.com/org/repo/pull/99");
    expect(phase?.status).toBe("READY_FOR_REVIEW");
    expect(phase?.tasks.every((task) => task.status === "DONE")).toBe(true);
    expect(git.ensureCleanCalls).toBe(1);
    expect(git.createBranchCalls).toHaveLength(1);
    expect(git.pushCalls).toHaveLength(1);
    expect(github.reviewCalls).toHaveLength(1);
    expect(chosenAssignees).toEqual(["MOCK_CLI", "MOCK_CLI"]);
    expect(notifier.messages[0]).toContain("ready for review");
  });

  test("runs CI fix loop and recovers from failure", async () => {
    const state = createPhaseState();
    state.phases[0].tasks = [
      {
        id: "22222222-2222-2222-2222-222222222222",
        title: "Fix task",
        description: "Fix CI issue",
        status: "TODO",
        assignee: "MOCK_CLI",
        dependencies: [],
      },
    ];

    const store = new InMemoryStateStore(state);
    const git = new MockGit();
    const github = new MockGitHub([
      { overall: "FAILURE", checks: [{ name: "build", state: "FAILURE" }] },
      { overall: "SUCCESS", checks: [{ name: "build", state: "SUCCESS" }] },
    ]);
    const notifier = new MockNotifier();
    const chosenAssignees: string[] = [];
    const adapterFactory = createAdapterFactory([successResult("initial"), successResult("fix")], chosenAssignees);

    const engine = new PhaseExecutionEngine({
      store,
      git,
      github,
      runner: createRunner(),
      adapterFactory,
      notifier,
    });

    const result = await engine.runPhase("11111111-1111-1111-1111-111111111111", {
      cwd: "C:/repo",
      availableAssignees: ["MOCK_CLI"],
      maxFixAttempts: 2,
    });

    const phase = (await store.readProjectState()).phases[0];
    expect(result.ciStatus.overall).toBe("SUCCESS");
    expect(phase?.status).toBe("READY_FOR_REVIEW");
    expect(chosenAssignees).toEqual(["MOCK_CLI", "MOCK_CLI"]);
    expect(git.pushCalls).toHaveLength(2);
    expect(notifier.messages.some((message) => message.includes("CI failed"))).toBe(true);
    expect(notifier.messages.some((message) => message.includes("CI recovered"))).toBe(true);
  });

  test("uses smart delegation to avoid codex when near quota", async () => {
    const state = createPhaseState();
    state.phases[0].tasks = [
      {
        id: "22222222-2222-2222-2222-222222222222",
        title: "Delegation task",
        description: "Choose best worker",
        status: "TODO",
        assignee: "UNASSIGNED",
        dependencies: [],
      },
    ];

    const store = new InMemoryStateStore(state);
    const git = new MockGit();
    const github = new MockGitHub([{ overall: "SUCCESS", checks: [] }]);
    const usageTracker = new MockUsageTracker({
      providers: {
        codex: {
          used: 95,
          quota: 100,
        },
      },
    });
    const chosenAssignees: string[] = [];
    const adapterFactory = createAdapterFactory([successResult("delegated")], chosenAssignees);

    const engine = new PhaseExecutionEngine({
      store,
      git,
      github,
      runner: createRunner(),
      adapterFactory,
      usageTracker,
    });

    await engine.runPhase("11111111-1111-1111-1111-111111111111", {
      cwd: "C:/repo",
      availableAssignees: ["CODEX_CLI", "GEMINI_CLI"],
    });

    expect(chosenAssignees[0]).toBe("GEMINI_CLI");
    const phase = (await store.readProjectState()).phases[0];
    expect(phase?.tasks[0]?.assignee).toBe("GEMINI_CLI");
  });
});

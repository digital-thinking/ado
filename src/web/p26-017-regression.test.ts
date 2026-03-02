/**
 * P26-017 – Regression/integration tests for Phase 26 agent UX + preflight tasks.
 *
 *  P26-014  top-5 recency ordering: API returns >5 agents sorted most-recent-first
 *           so the client-side `.slice(0, 5)` cap picks the correct top records;
 *           per-project filter preserves recency ordering within a project.
 *
 *  P26-015  reasoning-only log stream filter: live subscription output events are
 *           filtered with the same chatter rules as the backlog; mixed-content
 *           backlogs pass only reasoning lines.
 *
 *  P26-016  GitHub preflight parity diagnostics: network probe uses the actual
 *           remote URL from `git remote get-url origin` instead of a hardcoded
 *           fallback; falls back to the gitignore repo when origin lookup fails;
 *           auth failure kind is classified correctly with actionable guidance;
 *           network-level failure produces VPN/firewall guidance.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StateEngine } from "../state";
import { MockProcessRunner } from "../test-utils";
import { ControlCenterService } from "./control-center-service";
import { handleAgentsApi } from "./api/agents";
import type { ApiDependencies } from "./api/types";

// ---------------------------------------------------------------------------
// Shared helpers for log-stream tests (mirrors the helper in agents.test.ts)
// ---------------------------------------------------------------------------

function makeStreamDeps(outputTail: string[]): ApiDependencies {
  return {
    control: {
      getState: async () =>
        ({
          projectName: "project-a",
          rootDir: "/tmp/a",
          phases: [
            {
              id: "phase-1",
              name: "Phase 1",
              branchName: "phase-1",
              status: "CODING",
              tasks: [
                {
                  id: "task-1",
                  title: "Task One",
                  status: "DONE",
                  assignee: "CLAUDE_CLI",
                  dependencies: [],
                },
              ],
            },
          ],
        }) as any,
    } as any,
    agents: {
      list: () => [
        {
          id: "agent-1",
          name: "Coder",
          projectName: "project-a",
          phaseId: "phase-1",
          taskId: "task-1",
          status: "STOPPED",
          lastExitCode: 0,
          outputTail,
        },
      ],
    } as any,
    usage: {} as any,
    projectName: "project-a",
    defaultAgentCwd: "/tmp",
    availableWorkerAssignees: [] as any,
    getRuntimeConfig: async () => ({}) as any,
    updateRuntimeConfig: async () => ({}) as any,
    getProjects: async () => [] as any,
    getProjectState: async () => ({}) as any,
    updateProjectSettings: async () => ({}) as any,
    getGlobalSettings: async () => ({}) as any,
    updateGlobalSettings: async () => ({}) as any,
  };
}

async function collectStreamOutputLines(
  outputTail: string[],
): Promise<string[]> {
  const deps = makeStreamDeps(outputTail);
  const response = await handleAgentsApi(
    new Request("http://localhost/api/agents/agent-1/logs/stream"),
    new URL("http://localhost/api/agents/agent-1/logs/stream"),
    deps,
  );
  expect(response).not.toBeNull();
  const reader = response!.body!.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value).trim();
    if (text.startsWith("data: ")) {
      const payload = JSON.parse(text.slice("data: ".length)) as any;
      if (payload.type === "output" && typeof payload.line === "string") {
        lines.push(payload.line);
      }
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// P26-014: Top-5 recency ordering with >5 records
// ---------------------------------------------------------------------------

describe("P26-017/P26-014: GET /api/agents recency ordering with >5 records", () => {
  function makeListDeps(agents: any[]): ApiDependencies {
    return {
      agents: { list: () => agents } as any,
      projectName: "project-a",
      defaultAgentCwd: "/tmp",
    } as any;
  }

  test("returns 8 agents sorted descending so top-5 slice picks most recent", async () => {
    const timestamps = [
      "2026-02-20T01:00:00.000Z",
      "2026-02-20T02:00:00.000Z",
      "2026-02-20T03:00:00.000Z",
      "2026-02-20T04:00:00.000Z",
      "2026-02-20T05:00:00.000Z",
      "2026-02-20T06:00:00.000Z",
      "2026-02-20T07:00:00.000Z",
      "2026-02-20T08:00:00.000Z",
    ];
    // Deliberate shuffle to confirm sorting, not insertion order.
    const shuffled = [2, 5, 0, 7, 4, 1, 6, 3].map((i) => ({
      id: `agent-${i}`,
      name: `Agent ${i}`,
      projectName: "project-a",
      status: "STOPPED",
      startedAt: timestamps[i],
      outputTail: [],
    }));

    const response = await handleAgentsApi(
      new Request("http://localhost/api/agents"),
      new URL("http://localhost/api/agents"),
      makeListDeps(shuffled),
    );

    expect(response).not.toBeNull();
    const data = await response!.json();
    expect(data).toHaveLength(8);

    const ids: string[] = data.map((a: any) => a.id);
    // Full descending order.
    expect(ids).toEqual([
      "agent-7",
      "agent-6",
      "agent-5",
      "agent-4",
      "agent-3",
      "agent-2",
      "agent-1",
      "agent-0",
    ]);
    // The client applies `.slice(0, 5)` (AGENT_LIST_LIMIT = 5); confirm those 5
    // are the five most recent records.
    expect(ids.slice(0, 5)).toEqual([
      "agent-7",
      "agent-6",
      "agent-5",
      "agent-4",
      "agent-3",
    ]);
  });

  test("per-project filter applied after global sort preserves recency within project", async () => {
    const agents = [
      {
        id: "b-old",
        name: "B Old",
        projectName: "project-b",
        status: "STOPPED",
        startedAt: "2026-02-26T01:00:00.000Z",
        outputTail: [],
      },
      {
        id: "a-newest",
        name: "A Newest",
        projectName: "project-a",
        status: "STOPPED",
        startedAt: "2026-02-26T12:00:00.000Z",
        outputTail: [],
      },
      {
        id: "a-older",
        name: "A Older",
        projectName: "project-a",
        status: "STOPPED",
        startedAt: "2026-02-26T06:00:00.000Z",
        outputTail: [],
      },
      {
        id: "b-new",
        name: "B New",
        projectName: "project-b",
        status: "RUNNING",
        startedAt: "2026-02-26T11:00:00.000Z",
        outputTail: [],
      },
    ];

    const response = await handleAgentsApi(
      new Request("http://localhost/api/agents"),
      new URL("http://localhost/api/agents"),
      makeListDeps(agents),
    );

    expect(response).not.toBeNull();
    const data = await response!.json();

    // Global sort order: a-newest → b-new → a-older → b-old.
    expect(data[0].id).toBe("a-newest");
    expect(data[1].id).toBe("b-new");
    expect(data[2].id).toBe("a-older");
    expect(data[3].id).toBe("b-old");

    // The client filters by active project then slices.  Simulate that here:
    // project-a agents in the globally sorted list preserve recency ordering.
    const projectA: any[] = data.filter(
      (a: any) => a.projectName === "project-a",
    );
    expect(projectA).toHaveLength(2);
    expect(projectA[0].id).toBe("a-newest");
    expect(projectA[1].id).toBe("a-older");
  });

  test("untimed agents sort after all timed agents regardless of list position", async () => {
    const timed = Array.from({ length: 5 }, (_, i) => ({
      id: `timed-${i}`,
      name: `Timed ${i}`,
      projectName: "project-a",
      status: "STOPPED",
      startedAt: `2026-02-0${i + 1}T00:00:00.000Z`,
      outputTail: [],
    }));
    const untimed = [
      {
        id: "u-a",
        name: "U-A",
        projectName: "project-a",
        status: "STOPPED",
        outputTail: [],
      },
      {
        id: "u-b",
        name: "U-B",
        projectName: "project-a",
        status: "STOPPED",
        outputTail: [],
      },
    ];

    const response = await handleAgentsApi(
      new Request("http://localhost/api/agents"),
      new URL("http://localhost/api/agents"),
      makeListDeps([...untimed, ...timed]),
    );

    const data = await response!.json();
    expect(data).toHaveLength(7);

    const topFive: string[] = data.slice(0, 5).map((a: any) => a.id);
    const bottom: string[] = data.slice(5).map((a: any) => a.id);
    // All timed agents must come before untimed ones.
    expect(topFive.every((id) => id.startsWith("timed-"))).toBe(true);
    expect(bottom.every((id) => id.startsWith("u-"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P26-015: Reasoning-only log stream filter – additional integration scenarios
// ---------------------------------------------------------------------------

describe("P26-017/P26-015: log stream filter – additional integration scenarios", () => {
  test("live subscription output events are filtered same as backlog chatter", async () => {
    const received: any[] = [];

    const deps: ApiDependencies = {
      control: {
        getState: async () =>
          ({
            projectName: "project-a",
            rootDir: "/tmp/a",
            phases: [
              {
                id: "phase-1",
                name: "Phase 1",
                branchName: "phase-1",
                status: "CODING",
                tasks: [
                  {
                    id: "task-1",
                    title: "Task",
                    status: "IN_PROGRESS",
                    assignee: "CLAUDE_CLI",
                    dependencies: [],
                  },
                ],
              },
            ],
          }) as any,
      } as any,
      agents: {
        list: () => [
          {
            id: "agent-1",
            name: "Coder",
            projectName: "project-a",
            phaseId: "phase-1",
            taskId: "task-1",
            status: "RUNNING",
            outputTail: [],
          },
        ],
        subscribe: (_id: string, listener: (event: any) => void) => {
          setTimeout(() => {
            // chatter — should be suppressed
            listener({
              type: "output",
              agentId: "agent-1",
              line: "Read /src/foo.ts",
            });
            // reasoning — should pass through
            listener({
              type: "output",
              agentId: "agent-1",
              line: "Analyzing the failing reconciliation test",
            });
            // chatter — should be suppressed
            listener({
              type: "output",
              agentId: "agent-1",
              line: "Writing src/bar.ts",
            });
            // terminal — always sent
            listener({ type: "status", agentId: "agent-1", status: "STOPPED" });
          }, 5);
          return () => {};
        },
      } as any,
      usage: {} as any,
      projectName: "project-a",
      defaultAgentCwd: "/tmp",
      availableWorkerAssignees: [] as any,
      getRuntimeConfig: async () => ({}) as any,
      updateRuntimeConfig: async () => ({}) as any,
      getProjects: async () => [] as any,
      getProjectState: async () => ({}) as any,
      updateProjectSettings: async () => ({}) as any,
      getGlobalSettings: async () => ({}) as any,
      updateGlobalSettings: async () => ({}) as any,
    };

    const response = await handleAgentsApi(
      new Request("http://localhost/api/agents/agent-1/logs/stream"),
      new URL("http://localhost/api/agents/agent-1/logs/stream"),
      deps,
    );
    expect(response).not.toBeNull();
    const reader = response!.body!.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value).trim();
      if (text.startsWith("data: ")) {
        received.push(JSON.parse(text.slice("data: ".length)));
      }
    }

    const outputLines = received
      .filter((e) => e.type === "output")
      .map((e) => e.line);

    expect(outputLines).not.toContain("Read /src/foo.ts");
    expect(outputLines).not.toContain("Writing src/bar.ts");
    expect(outputLines).toContain("Analyzing the failing reconciliation test");

    // Terminal status must arrive despite chatter-only subscription events.
    const statusEvents = received.filter((e) => e.type === "status");
    expect(statusEvents.length).toBeGreaterThan(0);
  });

  test("mixed chatter and reasoning in backlog: only reasoning lines are streamed", async () => {
    const backlog = [
      "Read /src/engine/phase-runner.ts",
      "I need to understand the reconciliation flow",
      "● Glob(pattern: 'src/**/*.ts')",
      "Found 3 related files that need updating",
      "./src/state/active-phase.ts",
      "Writing src/engine/phase-runner.ts",
      "Implementing the fix for stale IN_PROGRESS detection",
    ];

    const lines = await collectStreamOutputLines(backlog);

    expect(lines).toEqual([
      "I need to understand the reconciliation flow",
      "Found 3 related files that need updating",
      "Implementing the fix for stale IN_PROGRESS detection",
    ]);
  });
});

// ---------------------------------------------------------------------------
// P26-016: GitHub capability preflight parity diagnostics
// ---------------------------------------------------------------------------

describe("P26-017/P26-016: GitHub capability preflight parity diagnostics", () => {
  let sandboxDir: string;
  let stateFilePath: string;
  let tasksMarkdownPath: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-p26-017-"));
    stateFilePath = join(sandboxDir, "state.json");
    tasksMarkdownPath = join(sandboxDir, "TASKS.md");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  /** Create a service + PR task and run it to completion (or preflight failure). */
  async function runPreflightTask(runner: MockProcessRunner) {
    const service = new ControlCenterService({
      stateEngine: new StateEngine(stateFilePath),
      tasksMarkdownFilePath: tasksMarkdownPath,
      sideEffectProbeRunner: runner,
      internalWorkRunner: async () => ({
        command: "codex",
        args: ["exec"],
        stdout: "done",
        stderr: "",
        durationMs: 1,
      }),
    });
    await service.ensureInitialized("IxADO", "C:/repo");

    const created = await service.createPhase({
      name: "Preflight Phase",
      branchName: "preflight-phase",
    });
    const phaseId = created.phases[0].id;
    const withTask = await service.createTask({
      phaseId,
      title: "Create PR Task",
      description: "Open pull request for phase",
      assignee: "CODEX_CLI",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    return service.startTaskAndWait({ phaseId, taskId, assignee: "CODEX_CLI" });
  }

  test("network probe name reflects actual remote URL from git remote get-url origin", async () => {
    const customRemoteUrl = "https://github.com/mycorp/private-repo.git";
    const runner = new MockProcessRunner([
      { stdout: "gh version 2.50.0\n" }, // gh --version
      { stdout: "github.com\n  Logged in to github.com as bot\n" }, // gh auth status
      { stdout: "Bot User\n" }, // git config user.name
      { stdout: "bot@corp.com\n" }, // git config user.email
      { stdout: `${customRemoteUrl}\n` }, // git remote get-url origin
      { stdout: "" }, // git ls-remote → empty stdout → preflight fails
    ]);

    const finished = await runPreflightTask(runner);
    const task = finished.phases[0].tasks[0];

    expect(task.status).toBe("FAILED");

    // Probe name must include the actual remote URL, not the hardcoded fallback.
    const probes: Array<{ name: string; success: boolean }> =
      task.completionVerification?.probes ?? [];
    const networkProbe = probes.find((p) => p.name.startsWith("git ls-remote"));
    expect(networkProbe?.name).toBe(`git ls-remote ${customRemoteUrl}`);

    // Also verify the runner received ls-remote with the correct URL.
    const lsRemoteCall = runner.calls.find(
      (c) => c.command === "git" && c.args?.includes("ls-remote"),
    );
    expect(lsRemoteCall?.args).toContain(customRemoteUrl);
  });

  test("network probe falls back to github/gitignore URL when git remote get-url origin fails", async () => {
    const FALLBACK_URL = "https://github.com/github/gitignore.git";
    const remoteError = new Error("fatal: not a git repository");
    const runner = new MockProcessRunner([
      { stdout: "gh version 2.50.0\n" }, // gh --version
      { stdout: "github.com\n  Logged in to github.com as bot\n" }, // gh auth status
      { stdout: "Bot User\n" }, // git config user.name
      { stdout: "bot@corp.com\n" }, // git config user.email
      remoteError, // git remote get-url origin → throws (no remote configured)
      { stdout: "" }, // git ls-remote fallback → empty → preflight fails
    ]);

    const finished = await runPreflightTask(runner);
    const task = finished.phases[0].tasks[0];

    expect(task.status).toBe("FAILED");

    const probes: Array<{ name: string; success: boolean }> =
      task.completionVerification?.probes ?? [];
    const networkProbe = probes.find((p) => p.name.startsWith("git ls-remote"));
    expect(networkProbe?.name).toBe(`git ls-remote ${FALLBACK_URL}`);

    // ls-remote must have been called with the fallback URL.
    const lsRemoteCall = runner.calls.find(
      (c) => c.command === "git" && c.args?.includes("ls-remote"),
    );
    expect(lsRemoteCall?.args).toContain(FALLBACK_URL);
  });

  test("auth failure produces auth failure kind with gh auth login guidance", async () => {
    const authError = new Error(
      "permission denied: not authenticated to github.com",
    );
    const runner = new MockProcessRunner([
      { stdout: "gh version 2.50.0\n" }, // gh --version: success
      authError, // gh auth status: throws with auth-related message
      { stdout: "Test User\n" }, // git config user.name
      { stdout: "test@corp.com\n" }, // git config user.email
      { stdout: "https://github.com/org/repo.git\n" }, // git remote get-url origin
      { stdout: "deadbeef\tHEAD\n" }, // git ls-remote: success (network OK)
    ]);

    const finished = await runPreflightTask(runner);
    const task = finished.phases[0].tasks[0];

    expect(task.status).toBe("FAILED");
    expect(task.adapterFailureKind).toBe("auth");
    expect(task.completionVerification?.missingSideEffects.join(" ")).toContain(
      "gh auth login --hostname github.com",
    );
  });

  test("network-level ls-remote failure produces VPN/firewall guidance", async () => {
    const networkError = new Error("ENOTFOUND: network name resolution failed");
    (networkError as any).code = "ENOTFOUND";
    const runner = new MockProcessRunner([
      { stdout: "gh version 2.50.0\n" }, // gh --version
      { stdout: "github.com\n  Logged in to github.com as bot\n" }, // gh auth status
      { stdout: "Bot User\n" }, // git config user.name
      { stdout: "bot@corp.com\n" }, // git config user.email
      { stdout: "https://github.com/org/repo.git\n" }, // git remote get-url origin
      networkError, // git ls-remote → throws with ENOTFOUND
    ]);

    const finished = await runPreflightTask(runner);
    const task = finished.phases[0].tasks[0];

    expect(task.status).toBe("FAILED");
    expect(task.completionVerification?.missingSideEffects.join(" ")).toMatch(
      /VPN|proxy|firewall|outbound/i,
    );
  });

  test("environment fingerprint captures gh version and git identity from actual probes", async () => {
    // Use a failing network probe so the fingerprint is captured in completionVerification.
    const runner = new MockProcessRunner([
      { stdout: "gh version 2.69.0 (2026-01-15)\n" }, // gh --version
      { stdout: "github.com\n  Logged in to github.com as engineer\n" }, // gh auth status
      { stdout: "Engineer User\n" }, // git config user.name
      { stdout: "engineer@myco.com\n" }, // git config user.email
      { stdout: "https://github.com/myco/engine.git\n" }, // git remote get-url origin
      { stdout: "" }, // git ls-remote → empty → preflight fails
    ]);

    const finished = await runPreflightTask(runner);
    const task = finished.phases[0].tasks[0];

    expect(task.status).toBe("FAILED");
    const fp = task.completionVerification?.envFingerprint;
    expect(fp).toBeDefined();
    expect(fp?.["gh_version"]).toContain("2.69.0");
    expect(fp?.["gh_user"]).toBe("engineer");
    expect(fp?.["git_user_name"]).toBe("Engineer User");
    expect(fp?.["git_user_email"]).toBe("engineer@myco.com");
    expect(fp?.["hostname"]).toBeDefined();
  });
});

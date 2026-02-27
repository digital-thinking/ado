/**
 * P26-012 – Phase 26 regression/integration tests.
 *
 * Provides regression coverage for all Phase 26 tasks to prevent future
 * regressions as the codebase evolves.
 *
 *  P26-001  failure-kind lifecycle (all 3 kinds, clear on recovery, schema rejection)
 *  P26-002  CI_FIX guardrail schema defaults and valid override bounds
 *  P26-003  all-phase IN_PROGRESS reconciliation at startup
 *  P26-004  per-task reconciliation fields cleared on reset
 *  P26-005  cross-store consistency (reconcileRunningAgentsWhere scenarios)
 *  P26-006  atomic persistence – no .tmp residue via ControlCenterService
 *  P26-007  adapter-ID schema-driven deserialization roundtrip
 *  P26-008  active-phase strict selection policy – all error codes
 *  P26-009  truncation marker boundary values (at cap vs. one over cap)
 *  P26-010  PhasePreflightError is a proper Error subclass
 *  P26-011  ControlCenterService typed-options constructor (optional fields)
 */

import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StateEngine } from "../state";
import { ControlCenterService } from "../web/control-center-service";
import { AgentSupervisor } from "../web/agent-supervisor";
import {
  ActivePhaseResolutionError,
  resolveActivePhaseStrict,
} from "../state/active-phase";
import {
  CLI_ADAPTER_IDS,
  ExecutionLoopSettingsSchema,
  PhaseFailureKindSchema,
} from "../types";
import type { ProjectState } from "../types";
import { PhasePreflightError } from "../errors";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makePersistedAgentRecord(
  id: string,
  status: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: `agent-${id.slice(0, 8)}`,
    command: "codex",
    args: [],
    cwd: "/tmp",
    status,
    startedAt: "2024-01-01T00:00:00.000Z",
    outputTail: [],
    ...overrides,
  };
}

function buildBaseState(): ProjectState {
  const now = new Date().toISOString();
  return {
    projectName: "IxADO",
    rootDir: "/repo",
    phases: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Phase 1",
        branchName: "phase-1",
        status: "PLANNING",
        tasks: [],
      },
    ],
    activePhaseId: "11111111-1111-4111-8111-111111111111",
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// P26-001 – failure-kind lifecycle regression
// ---------------------------------------------------------------------------

describe("P26-001 – failure-kind lifecycle regression", () => {
  let sandboxDir: string;
  let service: ControlCenterService;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-p26-001-"));
    service = new ControlCenterService({
      stateEngine: new StateEngine(join(sandboxDir, "state.json")),
      tasksMarkdownFilePath: join(sandboxDir, "TASKS.md"),
    });
    await service.ensureInitialized("IxADO", "/repo");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("failureKind is absent after a non-failure status transition", async () => {
    const created = await service.createPhase({
      name: "Phase NonFail",
      branchName: "phase-non-fail",
    });
    const phaseId = created.phases[0].id;

    // First set CI_FAILED with a kind
    await service.setPhaseStatus({
      phaseId,
      status: "CI_FAILED",
      failureKind: "LOCAL_TESTER",
    });

    // Transition to CODING (non-failure) — failureKind must be cleared
    const result = await service.setPhaseStatus({
      phaseId,
      status: "CODING",
    });
    expect(result.phases[0].status).toBe("CODING");
    expect(result.phases[0].failureKind).toBeUndefined();
  });

  test("PhaseFailureKindSchema rejects unknown kind strings", () => {
    const result = PhaseFailureKindSchema.safeParse("NETWORK_ERROR");
    expect(result.success).toBe(false);
  });

  test("PhaseFailureKindSchema rejects empty string", () => {
    const result = PhaseFailureKindSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  test("all three failure kinds survive a setPhaseStatus round-trip", async () => {
    for (const kind of [
      "LOCAL_TESTER",
      "REMOTE_CI",
      "AGENT_FAILURE",
    ] as const) {
      const created = await service.createPhase({
        name: `Phase ${kind}`,
        branchName: `phase-${kind.toLowerCase().replace(/_/g, "-")}`,
      });
      const phaseId = created.phases[created.phases.length - 1].id;
      const result = await service.setPhaseStatus({
        phaseId,
        status: "CI_FAILED",
        failureKind: kind,
      });
      expect(result.phases.find((p) => p.id === phaseId)?.failureKind).toBe(
        kind,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// P26-002 – CI_FIX guardrail schema defaults and bounds
// ---------------------------------------------------------------------------

describe("P26-002 – CI_FIX guardrail schema defaults and bounds", () => {
  test("ciFixMaxFanOut defaults to 10", () => {
    const settings = ExecutionLoopSettingsSchema.parse({});
    expect(settings.ciFixMaxFanOut).toBe(10);
  });

  test("ciFixMaxDepth defaults to 3", () => {
    const settings = ExecutionLoopSettingsSchema.parse({});
    expect(settings.ciFixMaxDepth).toBe(3);
  });

  test("ciFixMaxFanOut accepts values up to 50", () => {
    const settings = ExecutionLoopSettingsSchema.parse({ ciFixMaxFanOut: 50 });
    expect(settings.ciFixMaxFanOut).toBe(50);
  });

  test("ciFixMaxDepth accepts values up to 10", () => {
    const settings = ExecutionLoopSettingsSchema.parse({ ciFixMaxDepth: 10 });
    expect(settings.ciFixMaxDepth).toBe(10);
  });

  test("ciFixMaxFanOut rejects values above 50", () => {
    const result = ExecutionLoopSettingsSchema.safeParse({
      ciFixMaxFanOut: 51,
    });
    expect(result.success).toBe(false);
  });

  test("ciFixMaxDepth rejects values above 10", () => {
    const result = ExecutionLoopSettingsSchema.safeParse({ ciFixMaxDepth: 11 });
    expect(result.success).toBe(false);
  });

  test("ciFixMaxFanOut rejects zero (minimum is 1)", () => {
    const result = ExecutionLoopSettingsSchema.safeParse({
      ciFixMaxFanOut: 0,
    });
    expect(result.success).toBe(false);
  });

  test("ciFixMaxDepth rejects zero (minimum is 1)", () => {
    const result = ExecutionLoopSettingsSchema.safeParse({ ciFixMaxDepth: 0 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P26-003 – all-phase IN_PROGRESS reconciliation at startup
// ---------------------------------------------------------------------------

describe("P26-003 – all-phase IN_PROGRESS reconciliation", () => {
  let sandboxDir: string;
  let stateFilePath: string;
  let service: ControlCenterService;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-p26-003-"));
    stateFilePath = join(sandboxDir, "state.json");
    service = new ControlCenterService({
      stateEngine: new StateEngine(stateFilePath),
      tasksMarkdownFilePath: join(sandboxDir, "TASKS.md"),
    });
    await service.ensureInitialized("IxADO", "/repo");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("reconciles IN_PROGRESS tasks in three separate phases simultaneously", async () => {
    // Phase A
    const s1 = await service.createPhase({
      name: "Phase A",
      branchName: "phase-a",
    });
    const phase1Id = s1.phases[0].id;
    await service.createTask({
      phaseId: phase1Id,
      title: "A1",
      description: "Phase A task",
    });

    // Phase B
    const s2 = await service.createPhase({
      name: "Phase B",
      branchName: "phase-b",
    });
    const phase2Id = s2.phases.find((p) => p.id !== phase1Id)!.id;
    await service.createTask({
      phaseId: phase2Id,
      title: "B1",
      description: "Phase B task",
    });

    // Phase C
    const s3 = await service.createPhase({
      name: "Phase C",
      branchName: "phase-c",
    });
    const phase3Id = s3.phases.find(
      (p) => p.id !== phase1Id && p.id !== phase2Id,
    )!.id;
    await service.createTask({
      phaseId: phase3Id,
      title: "C1",
      description: "Phase C task",
    });

    // Manually force all tasks to IN_PROGRESS to simulate a crash
    const engine = new StateEngine(stateFilePath);
    const raw = await engine.readProjectState();
    for (const phase of raw.phases) {
      for (const task of phase.tasks) {
        (task as any).status = "IN_PROGRESS";
      }
    }
    await engine.writeProjectState(raw);

    // reconcile – should reset all 3 tasks across all 3 phases
    const count = await service.reconcileInProgressTasks();
    expect(count).toBe(3);

    const state = await service.getState();
    for (const phase of state.phases) {
      for (const task of phase.tasks) {
        expect(task.status).toBe("TODO");
      }
    }
  });

  test("returns 0 and leaves state unchanged when no tasks are IN_PROGRESS", async () => {
    await service.createPhase({ name: "Phase A", branchName: "phase-a" });
    await service.createPhase({ name: "Phase B", branchName: "phase-b" });

    const count = await service.reconcileInProgressTasks();
    expect(count).toBe(0);

    const state = await service.getState();
    expect(state.phases).toHaveLength(2);
  });

  test("only resets IN_PROGRESS tasks, preserving DONE and TODO tasks in the same phase", async () => {
    const s1 = await service.createPhase({
      name: "Phase Mixed",
      branchName: "phase-mixed",
    });
    const phaseId = s1.phases[0].id;
    await service.createTask({ phaseId, title: "T1", description: "Task one" });
    await service.createTask({ phaseId, title: "T2", description: "Task two" });
    await service.createTask({
      phaseId,
      title: "T3",
      description: "Task three",
    });

    const engine = new StateEngine(stateFilePath);
    const raw = await engine.readProjectState();
    (raw.phases[0].tasks[0] as any).status = "DONE";
    (raw.phases[0].tasks[1] as any).status = "IN_PROGRESS";
    (raw.phases[0].tasks[2] as any).status = "TODO";
    await engine.writeProjectState(raw);

    const count = await service.reconcileInProgressTasks();
    expect(count).toBe(1);

    const state = await service.getState();
    expect(state.phases[0].tasks[0].status).toBe("DONE");
    expect(state.phases[0].tasks[1].status).toBe("TODO");
    expect(state.phases[0].tasks[2].status).toBe("TODO");
  });
});

// ---------------------------------------------------------------------------
// P26-004 – per-task restart consistency hooks
// ---------------------------------------------------------------------------

describe("P26-004 – per-task restart consistency hooks regression", () => {
  let sandboxDir: string;
  let stateFilePath: string;
  let service: ControlCenterService;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-p26-004-"));
    stateFilePath = join(sandboxDir, "state.json");
    service = new ControlCenterService({
      stateEngine: new StateEngine(stateFilePath),
      tasksMarkdownFilePath: join(sandboxDir, "TASKS.md"),
    });
    await service.ensureInitialized("IxADO", "/repo");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("clears all residual task fields when resetting IN_PROGRESS → TODO", async () => {
    const created = await service.createPhase({
      name: "Phase 1",
      branchName: "p1",
    });
    const phaseId = created.phases[0].id;
    const withTask = await service.createTask({
      phaseId,
      title: "T1",
      description: "Task to reconcile",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    // Force task to IN_PROGRESS with residual diagnostic fields
    const engine = new StateEngine(stateFilePath);
    const raw = await engine.readProjectState();
    const task = raw.phases[0].tasks[0] as any;
    task.status = "IN_PROGRESS";
    task.resultContext = "some prior result context";
    task.errorLogs = "prior error logs";
    task.errorCategory = "UNKNOWN";
    await engine.writeProjectState(raw);

    await service.reconcileInProgressTaskToTodo({ taskId });

    const state = await service.getState();
    const reconciled = state.phases[0].tasks[0];
    expect(reconciled.status).toBe("TODO");
    expect(reconciled.resultContext).toBeUndefined();
    expect(reconciled.errorLogs).toBeUndefined();
    expect(reconciled.errorCategory).toBeUndefined();
  });

  test("reconcileInProgressTaskToTodo is idempotent – second call is a no-op", async () => {
    const created = await service.createPhase({
      name: "Phase 1",
      branchName: "p1",
    });
    const phaseId = created.phases[0].id;
    const withTask = await service.createTask({
      phaseId,
      title: "T1",
      description: "Task to reconcile",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    const engine = new StateEngine(stateFilePath);
    const raw = await engine.readProjectState();
    (raw.phases[0].tasks[0] as any).status = "IN_PROGRESS";
    await engine.writeProjectState(raw);

    await service.reconcileInProgressTaskToTodo({ taskId });
    // Second call: task is already TODO, must not throw or corrupt state
    await service.reconcileInProgressTaskToTodo({ taskId });

    const state = await service.getState();
    expect(state.phases[0].tasks[0].status).toBe("TODO");
  });

  test("reconcileInProgressTaskToTodo targets the correct task across multiple phases", async () => {
    const s1 = await service.createPhase({
      name: "Phase 1",
      branchName: "p1",
    });
    const phase1Id = s1.phases[0].id;
    const w1 = await service.createTask({
      phaseId: phase1Id,
      title: "P1T1",
      description: "Phase 1 task to reset",
    });
    const targetTaskId = w1.phases[0].tasks[0].id;

    const s2 = await service.createPhase({
      name: "Phase 2",
      branchName: "p2",
    });
    const phase2Id = s2.phases.find((p) => p.id !== phase1Id)!.id;
    await service.createTask({
      phaseId: phase2Id,
      title: "P2T1",
      description: "Phase 2 task to leave intact",
    });

    const engine = new StateEngine(stateFilePath);
    const raw = await engine.readProjectState();
    // Only mark the Phase 1 task as IN_PROGRESS
    (raw.phases[0].tasks[0] as any).status = "IN_PROGRESS";
    await engine.writeProjectState(raw);

    await service.reconcileInProgressTaskToTodo({ taskId: targetTaskId });

    const state = await service.getState();
    expect(state.phases[0].tasks[0].status).toBe("TODO");
    // Phase 2 task stays TODO
    expect(state.phases[1].tasks[0].status).toBe("TODO");
  });
});

// ---------------------------------------------------------------------------
// P26-005 – cross-store consistency (reconcileRunningAgentsWhere)
// ---------------------------------------------------------------------------

describe("P26-005 – cross-store reconcileRunningAgentsWhere regression", () => {
  let sandboxDir: string;
  let registryFilePath: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-p26-005-"));
    registryFilePath = join(sandboxDir, "agents.json");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("returns 0 when no agents in registry are RUNNING", () => {
    writeFileSync(
      registryFilePath,
      JSON.stringify([
        makePersistedAgentRecord(
          "aaaa0000-0000-4000-8000-000000000001",
          "STOPPED",
        ),
        makePersistedAgentRecord(
          "aaaa0000-0000-4000-8000-000000000002",
          "FAILED",
        ),
      ]),
      "utf8",
    );

    const supervisor = new AgentSupervisor({ registryFilePath });
    const count = supervisor.reconcileRunningAgentsWhere(() => true);

    expect(count).toBe(0);
  });

  test("returns 0 when the registry is empty", () => {
    writeFileSync(registryFilePath, "[]", "utf8");

    const supervisor = new AgentSupervisor({ registryFilePath });
    const count = supervisor.reconcileRunningAgentsWhere(() => true);

    expect(count).toBe(0);
  });

  test("returns 0 when predicate matches no RUNNING agents", () => {
    writeFileSync(
      registryFilePath,
      JSON.stringify([
        makePersistedAgentRecord(
          "bbbb0000-0000-4000-8000-000000000001",
          "RUNNING",
          { taskId: "task-keep" },
        ),
      ]),
      "utf8",
    );

    const supervisor = new AgentSupervisor({ registryFilePath });
    const count = supervisor.reconcileRunningAgentsWhere(
      (agent) => agent.taskId === "task-stop",
    );

    expect(count).toBe(0);
    expect(supervisor.list()[0].status).toBe("RUNNING");
  });

  test("stops all RUNNING agents when predicate matches all of them", () => {
    writeFileSync(
      registryFilePath,
      JSON.stringify([
        makePersistedAgentRecord(
          "cccc0000-0000-4000-8000-000000000001",
          "RUNNING",
        ),
        makePersistedAgentRecord(
          "cccc0000-0000-4000-8000-000000000002",
          "RUNNING",
        ),
        makePersistedAgentRecord(
          "cccc0000-0000-4000-8000-000000000003",
          "RUNNING",
        ),
      ]),
      "utf8",
    );

    const supervisor = new AgentSupervisor({ registryFilePath });
    const count = supervisor.reconcileRunningAgentsWhere(() => true);

    expect(count).toBe(3);
    for (const agent of supervisor.list()) {
      expect(agent.status).toBe("STOPPED");
    }
  });

  test("only stops RUNNING agents matching the predicate, leaves others untouched", () => {
    writeFileSync(
      registryFilePath,
      JSON.stringify([
        makePersistedAgentRecord(
          "dddd0000-0000-4000-8000-000000000001",
          "RUNNING",
          { taskId: "task-stale" },
        ),
        makePersistedAgentRecord(
          "dddd0000-0000-4000-8000-000000000002",
          "RUNNING",
          { taskId: "task-live" },
        ),
        makePersistedAgentRecord(
          "dddd0000-0000-4000-8000-000000000003",
          "STOPPED",
          { taskId: "task-stale" },
        ),
      ]),
      "utf8",
    );

    const supervisor = new AgentSupervisor({ registryFilePath });
    const count = supervisor.reconcileRunningAgentsWhere(
      (agent) => agent.taskId === "task-stale",
    );

    expect(count).toBe(1);

    const listed = supervisor.list();
    expect(
      listed.find((a) => a.taskId === "task-stale" && a.status === "RUNNING"),
    ).toBeUndefined();
    expect(listed.find((a) => a.taskId === "task-live")?.status).toBe(
      "RUNNING",
    );
  });
});

// ---------------------------------------------------------------------------
// P26-006 – atomic persistence regression (ControlCenterService layer)
// ---------------------------------------------------------------------------

describe("P26-006 – atomic persistence regression (ControlCenterService)", () => {
  let sandboxDir: string;
  let stateFilePath: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-p26-006-"));
    stateFilePath = join(sandboxDir, "state.json");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("no .tmp file remains after state writes via ControlCenterService", async () => {
    const service = new ControlCenterService({
      stateEngine: new StateEngine(stateFilePath),
      tasksMarkdownFilePath: join(sandboxDir, "TASKS.md"),
    });
    await service.ensureInitialized("IxADO", "/repo");
    await service.createPhase({ name: "Phase 1", branchName: "phase-1" });

    expect(existsSync(`${stateFilePath}.tmp`)).toBe(false);
    expect(existsSync(stateFilePath)).toBe(true);
  });

  test("state file contains valid JSON after multiple sequential writes", async () => {
    const service = new ControlCenterService({
      stateEngine: new StateEngine(stateFilePath),
      tasksMarkdownFilePath: join(sandboxDir, "TASKS.md"),
    });
    await service.ensureInitialized("IxADO", "/repo");

    for (let i = 1; i <= 4; i++) {
      await service.createPhase({
        name: `Phase ${i}`,
        branchName: `phase-${i}`,
      });
    }

    expect(existsSync(`${stateFilePath}.tmp`)).toBe(false);

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(stateFilePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.phases).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// P26-007 – adapter-ID schema-driven deserialization regression
// ---------------------------------------------------------------------------

describe("P26-007 – adapter-ID schema-driven deserialization regression", () => {
  let sandboxDir: string;
  let registryFilePath: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-p26-007-"));
    registryFilePath = join(sandboxDir, "agents.json");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("all CLI_ADAPTER_IDS are preserved through a registry round-trip", () => {
    const records = CLI_ADAPTER_IDS.map((id, index) => ({
      id: `d${String(index).padStart(7, "0")}-0000-4000-8000-000000000000`,
      name: `agent-${id}`,
      command: "codex",
      args: [],
      cwd: "/tmp",
      status: "STOPPED",
      startedAt: new Date().toISOString(),
      outputTail: [],
      adapterId: id,
    }));
    writeFileSync(registryFilePath, JSON.stringify(records), "utf8");

    const supervisor = new AgentSupervisor({ registryFilePath });
    const listed = supervisor.list();

    for (const adapterId of CLI_ADAPTER_IDS) {
      const agent = listed.find((a) => a.name === `agent-${adapterId}`);
      expect(agent).toBeDefined();
      expect(agent?.adapterId).toBe(adapterId);
    }
  });

  test("unknown adapter ID is silently dropped; agent record is still loaded", () => {
    writeFileSync(
      registryFilePath,
      JSON.stringify([
        {
          id: "eeee0000-0000-4000-8000-000000000000",
          name: "unknown-adapter-agent",
          command: "codex",
          args: [],
          cwd: "/tmp",
          status: "STOPPED",
          startedAt: new Date().toISOString(),
          outputTail: [],
          adapterId: "UNKNOWN_FUTURE_ADAPTER",
        },
      ]),
      "utf8",
    );

    const supervisor = new AgentSupervisor({ registryFilePath });
    const listed = supervisor.list();

    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("unknown-adapter-agent");
    expect(listed[0].adapterId).toBeUndefined();
  });

  test("missing adapterId field loads as undefined without error", () => {
    writeFileSync(
      registryFilePath,
      JSON.stringify([
        {
          id: "ffff0000-0000-4000-8000-000000000000",
          name: "no-adapter-agent",
          command: "codex",
          args: [],
          cwd: "/tmp",
          status: "STOPPED",
          startedAt: new Date().toISOString(),
          outputTail: [],
          // no adapterId field
        },
      ]),
      "utf8",
    );

    const supervisor = new AgentSupervisor({ registryFilePath });
    const listed = supervisor.list();

    expect(listed).toHaveLength(1);
    expect(listed[0].adapterId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P26-008 – active-phase strict selection policy regression
// ---------------------------------------------------------------------------

describe("P26-008 – active-phase strict selection policy regression", () => {
  test("throws ActivePhaseResolutionError (not a generic Error) for all failure conditions", () => {
    const cases: ProjectState[] = [
      { ...buildBaseState(), phases: [], activePhaseId: undefined },
      { ...buildBaseState(), activePhaseId: undefined },
      {
        ...buildBaseState(),
        activePhaseId: "99999999-9999-4999-8999-999999999999",
      },
    ];

    for (const state of cases) {
      let threw = false;
      try {
        resolveActivePhaseStrict(state);
      } catch (error) {
        threw = true;
        expect(error).toBeInstanceOf(ActivePhaseResolutionError);
        // Must NOT be a plain Error without the code property
        expect((error as ActivePhaseResolutionError).code).toBeDefined();
      }
      expect(threw).toBe(true);
    }
  });

  test("each failure condition produces a distinct, expected error code", () => {
    const codes: string[] = [];

    const collect = (state: ProjectState) => {
      try {
        resolveActivePhaseStrict(state);
      } catch (e) {
        codes.push((e as ActivePhaseResolutionError).code);
      }
    };

    collect({ ...buildBaseState(), phases: [], activePhaseId: undefined });
    collect({ ...buildBaseState(), activePhaseId: undefined });
    collect({
      ...buildBaseState(),
      activePhaseId: "99999999-9999-4999-8999-999999999999",
    });

    expect(codes).toEqual([
      "NO_PHASES",
      "ACTIVE_PHASE_ID_MISSING",
      "ACTIVE_PHASE_ID_NOT_FOUND",
    ]);
  });

  test("returns the matching phase when activePhaseId is valid", () => {
    const state = buildBaseState();
    const phase = resolveActivePhaseStrict(state);
    expect(phase.id).toBe("11111111-1111-4111-8111-111111111111");
  });
});

// ---------------------------------------------------------------------------
// P26-009 – truncation marker boundary values
// ---------------------------------------------------------------------------

describe("P26-009 – truncation marker boundary values regression", () => {
  let sandboxDir: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-p26-009-"));
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  async function runTaskWithOutput(
    output: string | null,
    error?: string,
  ): ReturnType<typeof import("../types").TaskSchema.parseAsync> {
    const stateFilePath = join(
      sandboxDir,
      `state-${Date.now()}-${Math.random()}.json`,
    );
    const service = new ControlCenterService({
      stateEngine: new StateEngine(stateFilePath),
      tasksMarkdownFilePath: join(sandboxDir, "TASKS.md"),
      internalWorkRunner: async () => {
        if (error !== undefined) {
          throw new Error(error);
        }
        return {
          command: "codex",
          args: [],
          stdout: output ?? "",
          stderr: "",
          durationMs: 1,
        };
      },
    });
    await service.ensureInitialized("IxADO", "/repo");

    const created = await service.createPhase({
      name: "P",
      branchName: "p",
    });
    const phaseId = created.phases[0].id;
    const withTask = await service.createTask({
      phaseId,
      title: "T",
      description: "Truncation test task",
    });
    const taskId = withTask.phases[0].tasks[0].id;

    const finished = await service.startTaskAndWait({
      phaseId,
      taskId,
      assignee: "CODEX_CLI",
    });
    return finished.phases[0].tasks[0] as any;
  }

  test("output at exactly 4 000 chars: stored in full without a truncation marker", async () => {
    const task = await runTaskWithOutput("a".repeat(4_000));
    expect(task.resultContext).not.toContain("[truncated]");
    expect(task.resultContext?.length).toBe(4_000);
  });

  test("output at 4 001 chars: stored as 4 000 chars ending with truncation marker", async () => {
    const task = await runTaskWithOutput("b".repeat(4_001));
    expect(task.resultContext).toEndWith("\n... [truncated]");
    expect(task.resultContext?.length).toBe(4_000);
  });

  test("errorLogs at exactly 4 000 chars: stored in full without marker", async () => {
    const task = await runTaskWithOutput(null, "c".repeat(4_000));
    expect(task.errorLogs).not.toContain("[truncated]");
    expect(task.errorLogs?.length).toBe(4_000);
  });

  test("errorLogs at 4 001 chars: stored as 4 000 chars ending with truncation marker", async () => {
    const task = await runTaskWithOutput(null, "d".repeat(4_001));
    expect(task.errorLogs).toEndWith("\n... [truncated]");
    expect(task.errorLogs?.length).toBe(4_000);
  });
});

// ---------------------------------------------------------------------------
// P26-010 – branch-base verification error type regression
// ---------------------------------------------------------------------------

describe("P26-010 – branch-base verification regression", () => {
  test("PhasePreflightError is a proper Error subclass with correct name", () => {
    const err = new PhasePreflightError("must checkout main first");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PhasePreflightError);
    expect(err.name).toBe("PhasePreflightError");
    expect(err.message).toBe("must checkout main first");
  });

  test("PhasePreflightError message is preserved exactly", () => {
    const msg =
      "HEAD is on 'dev/experiment' but phase branch 'feat/phase-1' does not exist.\n" +
      "Run: git checkout main";
    const err = new PhasePreflightError(msg);
    expect(err.message).toBe(msg);
  });
});

// ---------------------------------------------------------------------------
// P26-011 – ControlCenterService typed-options constructor regression
// ---------------------------------------------------------------------------

describe("P26-011 – ControlCenterService typed-options constructor regression", () => {
  let sandboxDir: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-p26-011-"));
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("constructs and initializes with only the required stateEngine field", async () => {
    const service = new ControlCenterService({
      stateEngine: new StateEngine(join(sandboxDir, "state.json")),
    });
    await service.ensureInitialized("IxADO", "/repo");
    const state = await service.getState();
    expect(state.projectName).toBe("IxADO");
  });

  test("onStateChange callback fires when state is mutated", async () => {
    const notifications: string[] = [];

    const service = new ControlCenterService({
      stateEngine: new StateEngine(join(sandboxDir, "state2.json")),
      onStateChange: (projectName) => {
        notifications.push(projectName);
      },
    });
    await service.ensureInitialized("IxADO", "/repo");
    await service.createPhase({ name: "Phase 1", branchName: "phase-1" });

    expect(notifications.length).toBeGreaterThanOrEqual(1);
    expect(notifications[0]).toBe("IxADO");
  });

  test("all optional constructor fields can be provided simultaneously without conflict", async () => {
    const notifications: string[] = [];

    const service = new ControlCenterService({
      stateEngine: new StateEngine(join(sandboxDir, "state3.json")),
      tasksMarkdownFilePath: join(sandboxDir, "TASKS.md"),
      onStateChange: (name) => {
        notifications.push(name);
      },
    });
    await service.ensureInitialized("IxADO", "/repo");
    await service.createPhase({ name: "Phase 1", branchName: "phase-1" });

    const state = await service.getState();
    expect(state.phases).toHaveLength(1);
    expect(notifications.length).toBeGreaterThanOrEqual(1);
  });

  test("stateEngineFactory function variant is accepted instead of a StateEngine instance", async () => {
    const service = new ControlCenterService({
      stateEngine: async (name: string) =>
        new StateEngine(join(sandboxDir, `state-${name}.json`)),
    });
    await service.ensureInitialized("IxADO", "/repo");
    const state = await service.getState();
    expect(state.projectName).toBe("IxADO");
  });
});

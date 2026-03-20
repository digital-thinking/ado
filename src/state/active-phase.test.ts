import { describe, expect, test } from "bun:test";

import {
  ActivePhaseResolutionError,
  resolvePrimaryActivePhaseId,
  resolveActivePhaseStrict,
} from "./active-phase";
import type { ProjectState } from "../types";

function buildState(): ProjectState {
  const now = new Date().toISOString();
  return {
    projectName: "IxADO",
    rootDir: "/tmp/repo",
    phases: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Phase 1",
        branchName: "phase-1",
        status: "PLANNING",
        tasks: [],
      },
    ],
    activePhaseIds: ["11111111-1111-4111-8111-111111111111"],
    createdAt: now,
    updatedAt: now,
  };
}

describe("resolveActivePhaseStrict", () => {
  test("returns active phase when activePhaseId matches", () => {
    const state = buildState();
    const expectedActivePhaseId = state.activePhaseIds[0];
    if (!expectedActivePhaseId) {
      throw new Error("Expected activePhaseId in test fixture.");
    }

    const phase = resolveActivePhaseStrict(state);

    expect(phase.id).toBe(expectedActivePhaseId);
  });

  test("throws when phases are empty", () => {
    const state = buildState();
    state.phases = [];
    state.activePhaseIds = [];

    try {
      resolveActivePhaseStrict(state);
      throw new Error("Expected resolveActivePhaseStrict to throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(ActivePhaseResolutionError);
      expect((error as ActivePhaseResolutionError).code).toBe("NO_PHASES");
    }
  });

  test("throws when activePhaseId is missing", () => {
    const state = buildState();
    state.activePhaseIds = [];

    try {
      resolveActivePhaseStrict(state);
      throw new Error("Expected resolveActivePhaseStrict to throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(ActivePhaseResolutionError);
      expect((error as ActivePhaseResolutionError).code).toBe(
        "ACTIVE_PHASE_ID_MISSING",
      );
    }
  });

  test("throws when activePhaseId does not exist in phases", () => {
    const state = buildState();
    state.activePhaseIds = ["22222222-2222-4222-8222-222222222222"];

    try {
      resolveActivePhaseStrict(state);
      throw new Error("Expected resolveActivePhaseStrict to throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(ActivePhaseResolutionError);
      expect((error as ActivePhaseResolutionError).code).toBe(
        "ACTIVE_PHASE_ID_NOT_FOUND",
      );
    }
  });

  test("resolves an explicit active target phase ID from the active set", () => {
    const state = buildState();
    const secondPhaseId = "22222222-2222-4222-8222-222222222222";
    state.phases.push({
      id: secondPhaseId,
      name: "Phase 2",
      branchName: "phase-2",
      status: "PLANNING",
      tasks: [],
    });
    state.activePhaseIds = [state.phases[0].id, secondPhaseId];

    const phase = resolveActivePhaseStrict(state, secondPhaseId);

    expect(phase.id).toBe(secondPhaseId);
  });

  test("throws when explicit target phase ID is not in active phase set", () => {
    const state = buildState();
    const secondPhaseId = "22222222-2222-4222-8222-222222222222";
    state.phases.push({
      id: secondPhaseId,
      name: "Phase 2",
      branchName: "phase-2",
      status: "PLANNING",
      tasks: [],
    });

    try {
      resolveActivePhaseStrict(state, secondPhaseId);
      throw new Error("Expected resolveActivePhaseStrict to throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(ActivePhaseResolutionError);
      expect((error as ActivePhaseResolutionError).code).toBe(
        "ACTIVE_PHASE_ID_NOT_FOUND",
      );
    }
  });
});

describe("resolvePrimaryActivePhaseId", () => {
  test("returns first non-empty active phase id in order", () => {
    const phaseId = resolvePrimaryActivePhaseId({
      activePhaseIds: [
        "   ",
        "\t",
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
    });

    expect(phaseId).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("returns undefined when no active phase ids are set", () => {
    expect(resolvePrimaryActivePhaseId({ activePhaseIds: [] })).toBeUndefined();
  });
});

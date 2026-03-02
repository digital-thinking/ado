import { describe, expect, test } from "bun:test";

import {
  ActivePhaseResolutionError,
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
    activePhaseId: "11111111-1111-4111-8111-111111111111",
    createdAt: now,
    updatedAt: now,
  };
}

describe("resolveActivePhaseStrict", () => {
  test("returns active phase when activePhaseId matches", () => {
    const state = buildState();
    const expectedActivePhaseId = state.activePhaseId;
    if (!expectedActivePhaseId) {
      throw new Error("Expected activePhaseId in test fixture.");
    }

    const phase = resolveActivePhaseStrict(state);

    expect(phase.id).toBe(expectedActivePhaseId);
  });

  test("throws when phases are empty", () => {
    const state = buildState();
    state.phases = [];
    state.activePhaseId = undefined;

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
    state.activePhaseId = undefined;

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
    state.activePhaseId = "22222222-2222-4222-8222-222222222222";

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
});

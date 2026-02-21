import { describe, expect, test } from "bun:test";

import { createPhaseExecutionEngine } from "./bootstrap";
import { PhaseExecutionEngine } from "./phase-execution-engine";

describe("engine bootstrap", () => {
  test("creates phase execution engine without telegram", () => {
    const engine = createPhaseExecutionEngine({
      cwd: "C:/repo",
      stateFilePath: "C:/repo/.ixado/state.json",
    });

    expect(engine).toBeInstanceOf(PhaseExecutionEngine);
  });

  test("creates phase execution engine with telegram notifier", () => {
    const engine = createPhaseExecutionEngine({
      cwd: "C:/repo",
      stateFilePath: "C:/repo/.ixado/state.json",
      telegram: {
        token: "token",
        ownerId: 123,
      },
    });

    expect(engine).toBeInstanceOf(PhaseExecutionEngine);
  });
});

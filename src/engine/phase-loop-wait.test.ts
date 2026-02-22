import { describe, expect, test } from "bun:test";

import { PhaseLoopControl } from "./phase-loop-control";
import { waitForAutoAdvance, waitForManualAdvance } from "./phase-loop-wait";

describe("phase loop wait helpers", () => {
  test("manual mode returns NEXT from local input", async () => {
    const loopControl = new PhaseLoopControl();
    let cancelled = false;

    const result = await waitForManualAdvance({
      loopControl,
      nextTaskLabel: "task #1",
      askLocal: async () => "NEXT",
      cancelLocal: () => {
        cancelled = true;
      },
    });

    expect(result).toBe("NEXT");
    expect(cancelled).toBe(false);
  });

  test("manual mode returns remote STOP and cancels local wait", async () => {
    const loopControl = new PhaseLoopControl();
    let cancelled = false;

    const promise = waitForManualAdvance({
      loopControl,
      nextTaskLabel: "task #1",
      askLocal: async () => new Promise<"NEXT" | "STOP">(() => {}),
      cancelLocal: () => {
        cancelled = true;
      },
    });
    loopControl.requestStop();

    await expect(promise).resolves.toBe("STOP");
    expect(cancelled).toBe(true);
  });

  test("auto mode returns NEXT after countdown", async () => {
    const loopControl = new PhaseLoopControl();
    let sleeps = 0;

    const result = await waitForAutoAdvance({
      loopControl,
      countdownSeconds: 2,
      nextTaskLabel: "task #2",
      sleep: async () => {
        sleeps += 1;
      },
    });

    expect(result).toBe("NEXT");
    expect(sleeps).toBe(2);
  });

  test("auto mode advances immediately when remote NEXT is requested", async () => {
    const loopControl = new PhaseLoopControl();
    const promise = waitForAutoAdvance({
      loopControl,
      countdownSeconds: 5,
      nextTaskLabel: "task #2",
      sleep: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      },
    });
    loopControl.requestNext();

    await expect(promise).resolves.toBe("NEXT");
  });

  test("auto mode stops when stop is requested", async () => {
    const loopControl = new PhaseLoopControl();
    loopControl.requestStop();

    const result = await waitForAutoAdvance({
      loopControl,
      countdownSeconds: 5,
      nextTaskLabel: "task #2",
      sleep: async () => {},
    });

    expect(result).toBe("STOP");
  });
});

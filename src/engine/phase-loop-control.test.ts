import { describe, expect, test } from "bun:test";

import { PhaseLoopControl } from "./phase-loop-control";

describe("PhaseLoopControl", () => {
  test("queues NEXT when no waiter exists", async () => {
    const control = new PhaseLoopControl();
    expect(control.requestNext()).toBe(true);

    const signal = await control.waitForSignal().promise;
    expect(signal).toBe("NEXT");
  });

  test("resolves waiting signal when next is requested", async () => {
    const control = new PhaseLoopControl();
    const waitHandle = control.waitForSignal();

    expect(control.requestNext()).toBe(true);
    await expect(waitHandle.promise).resolves.toBe("NEXT");
  });

  test("stop resolves pending waiters and blocks next", async () => {
    const control = new PhaseLoopControl();
    const waitHandle = control.waitForSignal();

    control.requestStop();
    expect(control.isStopRequested()).toBe(true);
    await expect(waitHandle.promise).resolves.toBe("STOP");
    expect(control.requestNext()).toBe(false);
  });

  test("cancelled waiters do not consume next request", async () => {
    const control = new PhaseLoopControl();
    const waitHandle = control.waitForSignal();
    control.cancelWait(waitHandle.id);

    expect(control.requestNext()).toBe(true);
    await expect(control.waitForSignal().promise).resolves.toBe("NEXT");
  });
});

import { describe, expect, test } from "bun:test";

import { CodexUsageTracker } from "./usage-tracker";
import { MockProcessRunner } from "./test-utils";

describe("CodexUsageTracker", () => {
  test("collects codexbar output as JSON snapshot", async () => {
    const runner = new MockProcessRunner([
      { stdout: "{\"providers\":{\"codex\":{\"used\":12,\"quota\":100}}}" },
    ]);
    const tracker = new CodexUsageTracker(runner);

    const snapshot = await tracker.collect("C:/repo");

    expect(runner.calls[0]).toEqual({
      command: "codexbar",
      args: ["--source", "cli", "--provider", "all", "--json"],
      cwd: "C:/repo",
    });
    expect(snapshot.payload).toEqual({
      providers: {
        codex: {
          used: 12,
          quota: 100,
        },
      },
    });
    expect(tracker.getSnapshots()).toHaveLength(1);
  });

  test("keeps only maxSnapshots entries", async () => {
    const runner = new MockProcessRunner([
      { stdout: "{\"index\":1}" },
      { stdout: "{\"index\":2}" },
      { stdout: "{\"index\":3}" },
    ]);
    const tracker = new CodexUsageTracker(runner, {
      maxSnapshots: 2,
    });

    await tracker.collect("C:/repo");
    await tracker.collect("C:/repo");
    await tracker.collect("C:/repo");

    const snapshots = tracker.getSnapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.payload).toEqual({ index: 2 });
    expect(snapshots[1]?.payload).toEqual({ index: 3 });
  });

  test("fails when codexbar output is invalid JSON", async () => {
    const runner = new MockProcessRunner([{ stdout: "not-json" }]);
    const tracker = new CodexUsageTracker(runner);

    await expect(tracker.collect("C:/repo")).rejects.toThrow("codexbar returned invalid JSON.");
  });

  test("polls until stop condition becomes false", async () => {
    const runner = new MockProcessRunner([
      { stdout: "{\"index\":1}" },
      { stdout: "{\"index\":2}" },
    ]);
    const tracker = new CodexUsageTracker(runner, {
      pollIntervalMs: 1,
    });

    let iterations = 0;
    const snapshots = await tracker.poll("C:/repo", () => {
      iterations += 1;
      return iterations <= 2;
    });

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.payload).toEqual({ index: 1 });
    expect(snapshots[1]?.payload).toEqual({ index: 2 });
  });

  test("fails fast for empty cwd", async () => {
    const runner = new MockProcessRunner();
    const tracker = new CodexUsageTracker(runner);

    await expect(tracker.collect("")).rejects.toThrow("cwd must not be empty.");
    await expect(tracker.poll("")).rejects.toThrow("cwd must not be empty.");
  });
});

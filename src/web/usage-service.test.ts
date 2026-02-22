import { describe, expect, test } from "bun:test";

import { UsageService } from "./usage-service";

describe("UsageService", () => {
  test("returns available usage snapshot", async () => {
    const service = new UsageService(
      {
        collect: async () => ({
          capturedAt: new Date().toISOString(),
          payload: { providers: { codex: { used: 12, quota: 100 } } },
          raw: '{"providers":{"codex":{"used":12,"quota":100}}}',
        }),
      },
      "C:/repo"
    );

    const result = await service.getLatest();
    expect(result.available).toBe(true);
    expect(result.snapshot?.payload).toEqual({
      providers: {
        codex: { used: 12, quota: 100 },
      },
    });
  });

  test("returns unavailable when tracker fails", async () => {
    const service = new UsageService(
      {
        collect: async () => {
          throw new Error("codexbar not installed");
        },
      },
      "C:/repo"
    );

    const result = await service.getLatest();
    expect(result.available).toBe(false);
    expect(result.message).toContain("codexbar not installed");
  });

  test("returns unavailable when codexbar usage telemetry is disabled", async () => {
    const service = new UsageService(
      {
        collect: async () => {
          throw new Error("tracker should not be called when disabled");
        },
      },
      "C:/repo",
      {
        codexbarEnabled: false,
      }
    );

    const result = await service.getLatest();
    expect(result.available).toBe(false);
    expect(result.message).toBe("codexbar usage telemetry is disabled by config.");
  });
});

import { describe, expect, test } from "bun:test";

import {
  buildAgentHeartbeatDiagnostic,
  buildAgentIdleDiagnostic,
  formatAgentRuntimeDiagnostic,
  parseAgentRuntimeDiagnostic,
  resolveLatestAgentRuntimeDiagnostic,
  summarizeAgentRuntimeDiagnostic,
} from "./agent-runtime-diagnostics";

describe("agent runtime diagnostics", () => {
  test("parses heartbeat marker lines and summarizes them", () => {
    const line = formatAgentRuntimeDiagnostic(
      buildAgentHeartbeatDiagnostic({
        occurredAt: "2026-02-25T20:00:00.000Z",
        agentId: "agent-1",
        adapterId: "CODEX_CLI",
        command: "codex",
        elapsedMs: 90_000,
        idleMs: 15_000,
      }),
    );

    const parsed = parseAgentRuntimeDiagnostic(line);
    expect(parsed?.event).toBe("heartbeat");
    expect(parsed?.agentId).toBe("agent-1");
    expect(parsed?.command).toBe("codex");
    if (!parsed) {
      throw new Error("Expected parsed heartbeat diagnostic.");
    }
    expect(summarizeAgentRuntimeDiagnostic(parsed)).toBe(
      "Heartbeat: elapsed 1m30s, idle 15s.",
    );
  });

  test("parses idle marker lines and resolves latest diagnostic in tail", () => {
    const heartbeat = formatAgentRuntimeDiagnostic(
      buildAgentHeartbeatDiagnostic({
        command: "claude",
        elapsedMs: 30_000,
        idleMs: 5_000,
      }),
    );
    const idle = formatAgentRuntimeDiagnostic(
      buildAgentIdleDiagnostic({
        occurredAt: "2026-02-25T20:02:00.000Z",
        command: "claude",
        elapsedMs: 120_000,
        idleMs: 120_000,
        idleThresholdMs: 60_000,
      }),
    );

    const latest = resolveLatestAgentRuntimeDiagnostic([
      "plain output",
      heartbeat,
      idle,
    ]);
    expect(latest?.event).toBe("idle-diagnostic");
    expect(latest?.occurredAt).toBe("2026-02-25T20:02:00.000Z");
    if (!latest) {
      throw new Error("Expected latest runtime diagnostic.");
    }
    expect(summarizeAgentRuntimeDiagnostic(latest)).toBe(
      "Idle 2m0s (elapsed 2m0s).",
    );
  });

  test("ignores malformed marker lines", () => {
    expect(
      parseAgentRuntimeDiagnostic("[ixado][agent-runtime]"),
    ).toBeUndefined();
    expect(
      parseAgentRuntimeDiagnostic(
        '[ixado][agent-runtime] {"marker":"ixado.agent.runtime","event":"heartbeat"}',
      ),
    ).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";

import {
  RuntimeEventSchema,
  createRuntimeEvent,
  formatRuntimeEventForCli,
  formatRuntimeEventForTelegram,
  toLegacyAgentEvent,
} from "./runtime-events";

describe("runtime event contract", () => {
  test("creates and validates task lifecycle events", () => {
    const event = createRuntimeEvent({
      family: "task-lifecycle",
      type: "task.lifecycle.start",
      payload: {
        assignee: "CODEX_CLI",
        resume: false,
        message: "Starting task #1.",
      },
      context: {
        source: "PHASE_RUNNER",
        projectName: "ixado",
        phaseId: "phase-1",
        taskId: "task-1",
      },
    });

    const parsed = RuntimeEventSchema.parse(event);
    expect(parsed.type).toBe("task.lifecycle.start");
    expect(parsed.family).toBe("task-lifecycle");
  });

  test("normalizes adapter output to legacy stream shape", () => {
    const event = createRuntimeEvent({
      family: "adapter-output",
      type: "adapter.output",
      payload: {
        stream: "stdout",
        line: "hello",
      },
      context: {
        source: "AGENT_SUPERVISOR",
        agentId: "agent-1",
      },
    });

    const legacy = toLegacyAgentEvent(event);
    expect(legacy).toEqual({
      type: "output",
      agentId: "agent-1",
      line: "hello",
    });
  });

  test("formats terminal outcome for CLI and Telegram consumers", () => {
    const event = createRuntimeEvent({
      family: "terminal-outcome",
      type: "terminal.outcome",
      payload: {
        outcome: "failure",
        summary: "Task failed after retries.",
      },
      context: {
        source: "PHASE_RUNNER",
      },
    });

    expect(formatRuntimeEventForCli(event)).toBe("Task failed after retries.");
    expect(formatRuntimeEventForTelegram(event)).toBe(
      "Outcome: Task failed after retries.",
    );
  });
});

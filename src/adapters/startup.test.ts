import { describe, expect, test } from "bun:test";

import {
  buildAdapterExecutionTimeoutDiagnostic,
  buildAdapterInitializationDiagnostic,
  buildAdapterStartupSilenceDiagnostic,
  formatAdapterRuntimeDiagnostic,
  formatAdapterStartupDiagnostic,
  getAdapterStartupPolicy,
} from "./startup";

describe("adapter startup policies", () => {
  test("defines startup policy for codex/claude/gemini and excludes mock", () => {
    expect(getAdapterStartupPolicy("CODEX_CLI")).toBeDefined();
    expect(getAdapterStartupPolicy("CLAUDE_CLI")).toBeDefined();
    expect(getAdapterStartupPolicy("GEMINI_CLI")).toBeDefined();
    expect(getAdapterStartupPolicy("MOCK_CLI")).toBeUndefined();
  });
});

describe("adapter startup diagnostics", () => {
  test("builds normalized initialization diagnostics for supported adapters", () => {
    for (const adapterId of [
      "CODEX_CLI",
      "CLAUDE_CLI",
      "GEMINI_CLI",
    ] as const) {
      const diagnostic = buildAdapterInitializationDiagnostic({
        adapterId,
        command:
          adapterId === "CODEX_CLI"
            ? "codex"
            : adapterId === "CLAUDE_CLI"
              ? "claude"
              : "gemini",
        baseArgs:
          adapterId === "CODEX_CLI"
            ? ["exec"]
            : adapterId === "CLAUDE_CLI"
              ? ["--print"]
              : ["--yolo"],
        cwd: "/tmp/project",
        timeoutMs: 123_000,
        startupSilenceTimeoutMs: 5_000,
      });

      expect(diagnostic).toBeDefined();
      expect(diagnostic?.marker).toBe("ixado.adapter.startup");
      expect(diagnostic?.event).toBe("adapter-initialized");
      expect(diagnostic?.adapterId).toBe(adapterId);
      expect(diagnostic?.checks.commandConfigured).toBe("pass");
      expect(diagnostic?.checks.nonInteractivePolicy).toBe("pass");
      expect(diagnostic?.context.cwd).toBe("/tmp/project");
      expect(diagnostic?.context.startupSilenceTimeoutMs).toBe(5_000);
      expect(diagnostic?.context.hint.length).toBeGreaterThan(0);
    }
  });

  test("builds normalized startup-silence diagnostic and formats it as ixado marker line", () => {
    const diagnostic = buildAdapterStartupSilenceDiagnostic({
      adapterId: "GEMINI_CLI",
      command: "gemini",
      startupSilenceTimeoutMs: 60_000,
    });

    expect(diagnostic.marker).toBe("ixado.adapter.runtime");
    expect(diagnostic.event).toBe("startup-silence-timeout");
    expect(diagnostic.adapterId).toBe("GEMINI_CLI");
    expect(diagnostic.command).toBe("gemini");
    expect(diagnostic.hint).toContain("Gemini");

    const line = formatAdapterRuntimeDiagnostic(diagnostic);
    expect(line).toContain("[ixado][adapter-runtime]");
    expect(line).toContain('"event":"startup-silence-timeout"');
  });

  test("builds normalized execution-timeout diagnostic with adapter-specific hint", () => {
    const diagnostic = buildAdapterExecutionTimeoutDiagnostic({
      adapterId: "CODEX_CLI",
      command: "codex",
      timeoutMs: 3_600_000,
      outputReceived: false,
    });

    expect(diagnostic.marker).toBe("ixado.adapter.runtime");
    expect(diagnostic.event).toBe("execution-timeout");
    expect(diagnostic.hint).toContain("codex auth login");

    const line = formatAdapterRuntimeDiagnostic(diagnostic);
    expect(line).toContain("[ixado][adapter-runtime]");
    expect(line).toContain('"event":"execution-timeout"');
  });

  test("startup formatter remains stable for adapter initialization lines", () => {
    const diagnostic = buildAdapterInitializationDiagnostic({
      adapterId: "CLAUDE_CLI",
      command: "claude",
      baseArgs: ["--print"],
      cwd: "/tmp/project",
      timeoutMs: 120_000,
      startupSilenceTimeoutMs: 5_000,
    });

    expect(diagnostic).toBeDefined();
    const line = formatAdapterStartupDiagnostic(diagnostic!);
    expect(line).toContain("[ixado][adapter-startup]");
    expect(line).toContain('"event":"adapter-initialized"');
  });

  test("P22-006: startup health detection returns no initialization diagnostic for unsupported startup adapters", () => {
    const diagnostic = buildAdapterInitializationDiagnostic({
      adapterId: "MOCK_CLI",
      command: "mock-cli",
      baseArgs: ["run"],
      cwd: "/tmp/project",
      timeoutMs: 120_000,
      startupSilenceTimeoutMs: 5_000,
    });

    expect(diagnostic).toBeUndefined();
  });

  test("P22-006: startup-silence diagnostic falls back to UNKNOWN adapter taxonomy when adapter identity is unavailable", () => {
    const diagnostic = buildAdapterStartupSilenceDiagnostic({
      command: "missing-adapter",
      startupSilenceTimeoutMs: 30_000,
    });

    expect(diagnostic.adapterId).toBe("UNKNOWN");
    expect(diagnostic.hint).toContain(
      "Verify the adapter CLI is installed, on PATH, and authenticated",
    );
  });
});

import { describe, expect, test } from "bun:test";

import {
  buildAdapterInitializationDiagnostic,
  buildAdapterStartupSilenceDiagnostic,
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

    expect(diagnostic.marker).toBe("ixado.adapter.startup");
    expect(diagnostic.event).toBe("startup-silence-timeout");
    expect(diagnostic.adapterId).toBe("GEMINI_CLI");
    expect(diagnostic.command).toBe("gemini");
    expect(diagnostic.hint).toContain("Gemini");

    const line = formatAdapterStartupDiagnostic(diagnostic);
    expect(line).toContain("[ixado][adapter-startup]");
    expect(line).toContain('"event":"startup-silence-timeout"');
  });
});

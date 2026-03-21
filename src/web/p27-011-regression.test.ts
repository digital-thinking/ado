import { describe, expect, test } from "bun:test";

import { controlCenterHtml } from "./ui/html";

function buildHtml(): string {
  return controlCenterHtml({
    webLogFilePath: "/tmp/web.log",
    cliLogFilePath: "/tmp/cli.log",
    defaultInternalWorkAssignee: "MOCK_CLI",
    defaultAutoMode: false,
    availableWorkerAssigneesJson: JSON.stringify(["MOCK_CLI", "CODEX_CLI"]),
    projectName: "ixado",
  });
}

describe("P27-011 web multi-phase UI regression", () => {
  test("renders active phase badge with multi-phase empty-state label", () => {
    const html = buildHtml();

    expect(html).toContain(
      '<span id="activePhaseBadge" class="pill">No active phases</span>',
    );
  });

  test("includes multi-phase resolution and formatting logic in the UI script", () => {
    const html = buildHtml();

    expect(html).toContain("function resolveActivePhases(state) {");
    expect(html).toContain(
      "(state.activePhaseIds || []).forEach((rawPhaseId) => {",
    );
    expect(html).toContain("function formatActivePhaseStatus(state) {");
    expect(html).toContain(
      '.map((phase) => phase.name + " (" + phase.status + ")")',
    );
    expect(html).toContain('.join(" | ");');
    expect(html).toContain("const activePhaseIds = new Set(");
    expect(html).toContain(
      "resolveActivePhases(state).map((phase) => phase.id)",
    );
  });
});

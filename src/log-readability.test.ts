import { describe, expect, test } from "bun:test";

import {
  buildRecoveryTraceLinks,
  formatPhaseTaskContext,
  isFileInteractionChatter,
  summarizeFailure,
  toAnchorToken,
} from "./log-readability";

describe("log readability helpers", () => {
  test("summarizeFailure prefers clear failure line and truncates", () => {
    const summary = summarizeFailure(
      [
        "stdout: completed step",
        "Error: command failed with exit code 2 after long output " +
          "x".repeat(200),
      ].join("\n"),
    );

    expect(summary).toContain("Error: command failed");
    expect(summary.length).toBeLessThanOrEqual(140);
  });

  test("formatPhaseTaskContext builds compact context label", () => {
    expect(
      formatPhaseTaskContext({
        phaseName: "Phase 22",
        taskNumber: 4,
        taskTitle: "Improve logs",
      }),
    ).toBe("Phase 22 | #4 Improve logs");
  });

  test("formatPhaseTaskContext truncates long phase name and task title", () => {
    expect(
      formatPhaseTaskContext({
        phaseName: "Phase 33: System Prompt Editor",
        taskNumber: 4,
        taskTitle: "33.4 Frontend prompt editor in Settings tab",
      }),
    ).toBe("Phase 33: System Prom… | #4 33.4 Frontend prompt…");
  });

  test("buildRecoveryTraceLinks includes task card and recovery links", () => {
    const links = buildRecoveryTraceLinks({
      context: { taskId: "task-abc" },
      attempts: [{ attemptNumber: 2 }],
    });

    expect(links).toEqual([
      { label: "Task card", href: "#task-card-task-abc" },
      { label: "Recovery attempt 2", href: "#task-recovery-task-abc-2" },
      { label: "Recovery history", href: "#task-recovery-task-abc" },
    ]);
  });

  test("toAnchorToken normalizes unusual strings", () => {
    expect(toAnchorToken(" task id/with spaces ")).toBe("task-id-with-spaces");
  });
});

describe("P26-015: isFileInteractionChatter", () => {
  // --- lines that SHOULD be filtered (chatter) ---

  test("filters plain Read verb with file path", () => {
    expect(isFileInteractionChatter("Read /src/components/Button.tsx")).toBe(
      true,
    );
  });

  test("filters Reading verb with file path", () => {
    expect(isFileInteractionChatter("Reading src/index.ts")).toBe(true);
  });

  test("filters Wrote verb with file path", () => {
    expect(isFileInteractionChatter("Wrote /tmp/output.ts")).toBe(true);
  });

  test("filters Write verb with file path", () => {
    expect(isFileInteractionChatter("Write src/util.ts")).toBe(true);
  });

  test("filters Writing verb with file path", () => {
    expect(isFileInteractionChatter("Writing src/util.ts")).toBe(true);
  });

  test("filters Edit verb with file path", () => {
    expect(isFileInteractionChatter("Edit src/engine/phase-runner.ts")).toBe(
      true,
    );
  });

  test("filters List verb with directory path", () => {
    expect(isFileInteractionChatter("List /src/components/")).toBe(true);
  });

  test("filters Listed verb with directory", () => {
    expect(isFileInteractionChatter("Listed src/web/")).toBe(true);
  });

  test("filters Bash colon prefix", () => {
    expect(isFileInteractionChatter("Bash: ls -la")).toBe(true);
  });

  test("filters tool-call function syntax (Claude-style)", () => {
    expect(isFileInteractionChatter('● Read(file_path: "/src/file.ts")')).toBe(
      true,
    );
  });

  test("filters Read with leading bullet and whitespace", () => {
    expect(isFileInteractionChatter("• Read /src/file.ts")).toBe(true);
  });

  test("filters Read with arrow prefix", () => {
    expect(isFileInteractionChatter("→ Read /path/to/file.ts")).toBe(true);
  });

  test("filters Grep verb with file pattern", () => {
    expect(isFileInteractionChatter("Grep src/**/*.ts")).toBe(true);
  });

  test("filters Glob verb with pattern", () => {
    expect(isFileInteractionChatter("Glob src/**/*.ts")).toBe(true);
  });

  test("filters Create verb with path", () => {
    expect(isFileInteractionChatter("Create src/new-file.ts")).toBe(true);
  });

  test("filters Delete verb with path", () => {
    expect(isFileInteractionChatter("Delete /tmp/old.ts")).toBe(true);
  });

  test("filters Ran verb with path", () => {
    expect(isFileInteractionChatter("Ran /usr/bin/tsc")).toBe(true);
  });

  test("filters exec with call syntax", () => {
    expect(isFileInteractionChatter("exec(cmd: 'bun test')")).toBe(true);
  });

  test("filters standalone absolute path line", () => {
    expect(isFileInteractionChatter("/root/scm/ado/src/types/index.ts")).toBe(
      true,
    );
  });

  test("filters standalone relative path line", () => {
    expect(isFileInteractionChatter("./src/engine/phase-runner.ts")).toBe(true);
  });

  test("filters standalone home-relative path line", () => {
    expect(isFileInteractionChatter("~/projects/ixado/src/file.ts")).toBe(true);
  });

  // --- lines that should NOT be filtered (reasoning / terminal context) ---

  test("preserves ixado system diagnostic lines", () => {
    expect(
      isFileInteractionChatter(
        "[ixado][heartbeat] agent=abc elapsed=30s idle=10s",
      ),
    ).toBe(false);
  });

  test("preserves lines with 'error' keyword", () => {
    expect(
      isFileInteractionChatter("Error: command failed with exit code 2"),
    ).toBe(false);
  });

  test("preserves lines with 'failed' keyword", () => {
    expect(isFileInteractionChatter("Tests failed: 3 suites")).toBe(false);
  });

  test("preserves lines with 'timeout' keyword", () => {
    expect(
      isFileInteractionChatter("Operation timed out after 60 seconds"),
    ).toBe(false);
  });

  test("preserves lines with 'exit code' phrase", () => {
    expect(isFileInteractionChatter("Process exited with exit code 1")).toBe(
      false,
    );
  });

  test("preserves 'Read' verb followed by reasoning text (not a path)", () => {
    expect(
      isFileInteractionChatter(
        "Read through the codebase and found three issues",
      ),
    ).toBe(false);
  });

  test("preserves 'Writing' verb when followed by reasoning (not a path)", () => {
    expect(
      isFileInteractionChatter(
        "Writing an implementation plan based on the current schema",
      ),
    ).toBe(false);
  });

  test("preserves substantive reasoning text", () => {
    expect(
      isFileInteractionChatter(
        "I need to update the phase-runner to handle the new failure kind semantics",
      ),
    ).toBe(false);
  });

  test("preserves agent completion message", () => {
    expect(isFileInteractionChatter("Agent completed with exit code 0.")).toBe(
      false,
    );
  });

  test("preserves task progress update", () => {
    expect(
      isFileInteractionChatter(
        "Implementing the reconcileInProgressTasks function...",
      ),
    ).toBe(false);
  });

  test("preserves diagnostic summary from heartbeat", () => {
    expect(
      isFileInteractionChatter(
        "[agent-runtime] Heartbeat: elapsed 2m0s, idle 30s.",
      ),
    ).toBe(false);
  });

  // --- patch diff lines (apply_patch / unified-diff output) ---

  test("filters patch addition line (+code)", () => {
    expect(
      isFileInteractionChatter("+    assert saved.status_code == 200"),
    ).toBe(true);
  });

  test("filters patch addition line (+def)", () => {
    expect(isFileInteractionChatter("+def optional_float(raw_value):")).toBe(
      true,
    );
  });

  test("filters bare + line (empty patch addition)", () => {
    expect(isFileInteractionChatter("+")).toBe(true);
  });

  test("filters patch deletion line (-code without space)", () => {
    expect(isFileInteractionChatter("-    old_line = True")).toBe(true);
  });

  test("filters patch hunk header", () => {
    expect(isFileInteractionChatter("@@ -42,7 +42,12 @@")).toBe(true);
  });

  test("filters apply_patch Begin Patch marker", () => {
    expect(isFileInteractionChatter("*** Begin Patch")).toBe(true);
  });

  test("filters apply_patch End Patch marker", () => {
    expect(isFileInteractionChatter("*** End Patch")).toBe(true);
  });

  test("filters apply_patch Update File marker", () => {
    expect(isFileInteractionChatter("*** Update File: /src/foo.ts")).toBe(true);
  });

  test("preserves markdown bullet starting with dash-space", () => {
    expect(isFileInteractionChatter("- Added versioned storage schema")).toBe(
      false,
    );
  });

  test("preserves markdown bold summary header", () => {
    expect(isFileInteractionChatter("**Summary**")).toBe(false);
  });

  // --- JSON blob lines ---

  test("filters long JSON blob line", () => {
    const blob =
      '{"phases":[{"name":"Phase 1","tasks":[' +
      '"x".repeat(200)'.padEnd(200, '"x"') +
      "]}]}";
    expect(
      isFileInteractionChatter(
        '{"phases":[{"name":"Phase 1","tasks":[],"extra":"' +
          "a".repeat(180) +
          '"}}]}',
      ),
    ).toBe(true);
  });

  test("preserves short JSON (structured log message)", () => {
    expect(isFileInteractionChatter('{"event":"done","status":"ok"}')).toBe(
      false,
    );
  });
});

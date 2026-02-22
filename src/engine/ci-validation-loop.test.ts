import { describe, expect, test } from "bun:test";

import type { CLIAdapterId, Phase } from "../types";
import { runCiValidationLoop } from "./ci-validation-loop";

const TEST_PHASE: Phase = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Phase 5: CI Execution Loop",
  branchName: "phase-5-ci-execution-loop",
  status: "PLANNING",
  tasks: [],
};

type WorkCall = {
  assignee: CLIAdapterId;
  phaseId: string;
  prompt: string;
  resume?: boolean;
};

describe("runCiValidationLoop", () => {
  test("approves immediately when git diff is empty", async () => {
    let callCount = 0;
    const result = await runCiValidationLoop({
      projectName: "IxADO",
      rootDir: "C:/repo",
      phase: TEST_PHASE,
      assignee: "CODEX_CLI",
      maxRetries: 2,
      readGitDiff: async () => "",
      runInternalWork: async () => {
        callCount += 1;
        return {
          stdout: "",
          stderr: "",
        };
      },
    });

    expect(result.status).toBe("APPROVED");
    expect(result.fixAttempts).toBe(0);
    expect(result.reviews).toEqual([]);
    expect(callCount).toBe(0);
  });

  test("approves on first review without fixer run", async () => {
    const calls: WorkCall[] = [];
    const result = await runCiValidationLoop({
      projectName: "IxADO",
      rootDir: "C:/repo",
      phase: TEST_PHASE,
      assignee: "CODEX_CLI",
      maxRetries: 2,
      readGitDiff: async () => "diff --git a/src/a.ts b/src/a.ts",
      runInternalWork: async (input) => {
        calls.push(input);
        return {
          stdout: '{"verdict":"APPROVED","comments":[]}',
          stderr: "",
        };
      },
    });

    expect(result.status).toBe("APPROVED");
    expect(result.fixAttempts).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("Worker archetype: REVIEWER");
  });

  test("runs fixer and re-reviews until approved", async () => {
    const calls: WorkCall[] = [];
    let reviewCount = 0;
    const diffValues = [
      "diff --git a/src/a.ts b/src/a.ts",
      "diff --git a/src/a.ts b/src/a.ts\n+fix",
    ];
    const result = await runCiValidationLoop({
      projectName: "IxADO",
      rootDir: "C:/repo",
      phase: TEST_PHASE,
      assignee: "CLAUDE_CLI",
      maxRetries: 3,
      readGitDiff: async () => diffValues[Math.min(reviewCount, diffValues.length - 1)],
      runInternalWork: async (input) => {
        calls.push(input);
        if (input.prompt.includes("Worker archetype: REVIEWER")) {
          reviewCount += 1;
          if (reviewCount === 1) {
            return {
              stdout: '{"verdict":"CHANGES_REQUESTED","comments":["Add test for edge case"]}',
              stderr: "",
            };
          }

          return {
            stdout: '{"verdict":"APPROVED","comments":[]}',
            stderr: "",
          };
        }

        return {
          stdout: "Applied fix and ran tests.",
          stderr: "",
        };
      },
    });

    expect(result.status).toBe("APPROVED");
    expect(result.fixAttempts).toBe(1);
    expect(result.reviews).toHaveLength(2);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.prompt).toContain("Worker archetype: FIXER");
    expect(calls[1]?.resume).toBe(false);
  });

  test("stops when max retries are exhausted", async () => {
    const result = await runCiValidationLoop({
      projectName: "IxADO",
      rootDir: "C:/repo",
      phase: TEST_PHASE,
      assignee: "GEMINI_CLI",
      maxRetries: 1,
      readGitDiff: async () => "diff --git a/src/a.ts b/src/a.ts",
      runInternalWork: async (input) => {
        if (input.prompt.includes("Worker archetype: REVIEWER")) {
          return {
            stdout: "```json\n{\"verdict\":\"CHANGES_REQUESTED\",\"comments\":[\"Fix lint issue\"]}\n```",
            stderr: "",
          };
        }

        return {
          stdout: "fixed once",
          stderr: "",
        };
      },
    });

    expect(result.status).toBe("MAX_RETRIES_EXCEEDED");
    if (result.status !== "MAX_RETRIES_EXCEEDED") {
      throw new Error("Expected MAX_RETRIES_EXCEEDED result");
    }
    expect(result.fixAttempts).toBe(1);
    expect(result.maxRetries).toBe(1);
    expect(result.pendingComments).toEqual(["Fix lint issue"]);
  });

  test("fails fast when maxRetries is invalid", async () => {
    await expect(
      runCiValidationLoop({
        projectName: "IxADO",
        rootDir: "C:/repo",
        phase: TEST_PHASE,
        assignee: "CODEX_CLI",
        maxRetries: -1,
        readGitDiff: async () => "",
        runInternalWork: async () => ({ stdout: "", stderr: "" }),
      })
    ).rejects.toThrow("maxRetries must be a non-negative integer.");
  });

  test("fails fast when reviewer requests changes without comments", async () => {
    await expect(
      runCiValidationLoop({
        projectName: "IxADO",
        rootDir: "C:/repo",
        phase: TEST_PHASE,
        assignee: "CODEX_CLI",
        maxRetries: 1,
        readGitDiff: async () => "diff --git a/src/a.ts b/src/a.ts",
        runInternalWork: async () => ({
          stdout: '{"verdict":"CHANGES_REQUESTED","comments":[]}',
          stderr: "",
        }),
      })
    ).rejects.toThrow("Reviewer verdict CHANGES_REQUESTED requires at least one comment.");
  });
});

import { describe, expect, test } from "bun:test";

import type { CLIAdapterId, Phase, Task } from "../types";
import { runDeliberationPass } from "./deliberation-pass";

const TEST_PHASE: Phase = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Phase 30: Deliberation Mode",
  branchName: "phase-30-deliberation-mode",
  status: "CODING",
  tasks: [],
};

const TEST_TASK: Task = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "Implement runDeliberationPass",
  description:
    "Implement propose, critique, and refine loop that produces a structured deliberation summary.",
  deliberate: true,
  status: "TODO",
  assignee: "UNASSIGNED",
  dependencies: [],
};

type WorkCall = {
  assignee: CLIAdapterId;
  phaseId: string;
  taskId: string;
  prompt: string;
  resume?: boolean;
};

describe("runDeliberationPass", () => {
  test("returns approved summary when first critique approves", async () => {
    const calls: WorkCall[] = [];
    const result = await runDeliberationPass({
      projectName: "IxADO",
      rootDir: "C:/repo",
      phase: TEST_PHASE,
      task: TEST_TASK,
      implementerAssignee: "CODEX_CLI",
      reviewerAssignee: "CLAUDE_CLI",
      maxRefinePasses: 2,
      runInternalWork: async (input) => {
        calls.push(input);
        if (input.prompt.includes("Deliberation Stage: PROPOSE")) {
          return {
            stdout:
              '{"proposal":"Add runDeliberationPass with zod contracts and loop."}',
            stderr: "",
          };
        }
        return {
          stdout: '{"verdict":"APPROVED","comments":[]}',
          stderr: "",
        };
      },
    });

    expect(result.status).toBe("APPROVED");
    expect(result.refinedPrompt).toContain("runDeliberationPass");
    expect(result.summary.rounds).toHaveLength(1);
    expect(result.summary.refinePassesUsed).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.assignee).toBe("CODEX_CLI");
    expect(calls[0]?.resume).toBe(false);
    expect(calls[1]?.assignee).toBe("CLAUDE_CLI");
    expect(calls[1]?.prompt).toContain("Deliberation Stage: CRITIQUE");
  });

  test("runs refinement until reviewer approves", async () => {
    const calls: WorkCall[] = [];
    let reviewRound = 0;

    const result = await runDeliberationPass({
      projectName: "IxADO",
      rootDir: "C:/repo",
      phase: TEST_PHASE,
      task: TEST_TASK,
      implementerAssignee: "GEMINI_CLI",
      reviewerAssignee: "CODEX_CLI",
      maxRefinePasses: 3,
      runInternalWork: async (input) => {
        calls.push(input);
        if (input.prompt.includes("Deliberation Stage: PROPOSE")) {
          return {
            stdout: '{"proposal":"Initial proposal"}',
            stderr: "",
          };
        }
        if (input.prompt.includes("Deliberation Stage: REFINE")) {
          return {
            stdout: '```json\n{"proposal":"Refined proposal with tests"}\n```',
            stderr: "",
          };
        }

        reviewRound += 1;
        if (reviewRound === 1) {
          return {
            stdout:
              '{"verdict":"CHANGES_REQUESTED","comments":["Specify test coverage"]}',
            stderr: "",
          };
        }
        return {
          stdout: '{"verdict":"APPROVED","comments":[]}',
          stderr: "",
        };
      },
    });

    expect(result.status).toBe("APPROVED");
    expect(result.refinedPrompt).toBe("Refined proposal with tests");
    expect(result.summary.refinePassesUsed).toBe(1);
    expect(result.summary.rounds).toHaveLength(2);
    expect(result.summary.rounds[0]?.verdict).toBe("CHANGES_REQUESTED");
    expect(result.summary.rounds[1]?.verdict).toBe("APPROVED");
    expect(calls).toHaveLength(4);
    expect(calls[2]?.prompt).toContain("Deliberation Stage: REFINE");
    expect(calls[2]?.resume).toBe(true);
  });

  test("stops when max refine passes are exceeded", async () => {
    const result = await runDeliberationPass({
      projectName: "IxADO",
      rootDir: "C:/repo",
      phase: TEST_PHASE,
      task: TEST_TASK,
      implementerAssignee: "CODEX_CLI",
      reviewerAssignee: "CLAUDE_CLI",
      maxRefinePasses: 1,
      runInternalWork: async (input) => {
        if (input.prompt.includes("Deliberation Stage: PROPOSE")) {
          return {
            stdout: '{"proposal":"Initial proposal"}',
            stderr: "",
          };
        }
        if (input.prompt.includes("Deliberation Stage: REFINE")) {
          return {
            stdout: '{"proposal":"Refined once"}',
            stderr: "",
          };
        }
        return {
          stdout:
            '{"verdict":"CHANGES_REQUESTED","comments":["Still missing edge cases"]}',
          stderr: "",
        };
      },
    });

    expect(result.status).toBe("MAX_REFINE_PASSES_EXCEEDED");
    expect(result.refinedPrompt).toBe("Refined once");
    expect(result.summary.refinePassesUsed).toBe(1);
    expect(result.summary.finalVerdict).toBe("CHANGES_REQUESTED");
    expect(result.summary.pendingComments).toEqual([
      "Still missing edge cases",
    ]);
    expect(result.summary.rounds).toHaveLength(2);
  });

  test("fails fast when critique requests changes without comments", async () => {
    await expect(
      runDeliberationPass({
        projectName: "IxADO",
        rootDir: "C:/repo",
        phase: TEST_PHASE,
        task: TEST_TASK,
        implementerAssignee: "CODEX_CLI",
        reviewerAssignee: "CLAUDE_CLI",
        maxRefinePasses: 1,
        runInternalWork: async (input) => {
          if (input.prompt.includes("Deliberation Stage: PROPOSE")) {
            return {
              stdout: '{"proposal":"Initial proposal"}',
              stderr: "",
            };
          }
          return {
            stdout: '{"verdict":"CHANGES_REQUESTED","comments":[]}',
            stderr: "",
          };
        },
      }),
    ).rejects.toThrow(
      "Critique verdict CHANGES_REQUESTED requires at least one comment.",
    );
  });

  test("fails fast when maxRefinePasses is invalid", async () => {
    await expect(
      runDeliberationPass({
        projectName: "IxADO",
        rootDir: "C:/repo",
        phase: TEST_PHASE,
        task: TEST_TASK,
        implementerAssignee: "CODEX_CLI",
        reviewerAssignee: "CLAUDE_CLI",
        maxRefinePasses: 0,
        runInternalWork: async () => ({ stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow("maxRefinePasses must be a positive integer.");
  });
});

import { describe, expect, test } from "bun:test";

import { buildWorkerPrompt, getWorkerSystemPrompt } from "./worker-prompts";
import type { Phase, Task } from "../types";

const TEST_PHASE: Phase = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Phase 5: CI Execution Loop",
  branchName: "phase-5-ci-execution-loop",
  status: "PLANNING",
  tasks: [],
};

const TEST_TASK: Task = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "P5-001 Define worker archetypes and prompts",
  description: "Define worker archetypes and ensure reviewer consumes git diff context.",
  status: "TODO",
  assignee: "UNASSIGNED",
  dependencies: [],
};

describe("worker prompts", () => {
  test("returns system prompts for known worker archetypes", () => {
    expect(getWorkerSystemPrompt("CODER")).toContain("Implement the task");
    expect(getWorkerSystemPrompt("TESTER")).toContain("Execute validations");
    expect(getWorkerSystemPrompt("REVIEWER")).toContain("git diff");
    expect(getWorkerSystemPrompt("FIXER")).toContain("Resolve reported failures");
  });

  test("builds coder prompt with project and task context", () => {
    const prompt = buildWorkerPrompt({
      archetype: "CODER",
      projectName: "IxADO",
      rootDir: "C:/repo",
      phase: TEST_PHASE,
      task: TEST_TASK,
    });

    expect(prompt).toContain("Worker archetype: CODER");
    expect(prompt).toContain("Phase: Phase 5: CI Execution Loop");
    expect(prompt).toContain("Task: P5-001 Define worker archetypes and prompts");
  });

  test("fails fast when reviewer prompt has no git diff context", () => {
    expect(() =>
      buildWorkerPrompt({
        archetype: "REVIEWER",
        projectName: "IxADO",
        rootDir: "C:/repo",
        phase: TEST_PHASE,
        task: TEST_TASK,
      })
    ).toThrow("Reviewer prompt requires gitDiff context.");
  });

  test("includes git diff context in reviewer prompt", () => {
    const prompt = buildWorkerPrompt({
      archetype: "REVIEWER",
      projectName: "IxADO",
      rootDir: "C:/repo",
      phase: TEST_PHASE,
      task: TEST_TASK,
      gitDiff: "diff --git a/src/a.ts b/src/a.ts",
    });

    expect(prompt).toContain("Git diff to review:");
    expect(prompt).toContain("diff --git a/src/a.ts b/src/a.ts");
  });
});

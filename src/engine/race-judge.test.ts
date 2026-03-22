import { describe, expect, test } from "bun:test";

import { buildRaceJudgePrompt, parseRaceJudgeVerdict } from "./race-judge";

describe("race judge", () => {
  test("builds a structured prompt with branch diffs and outputs", () => {
    const prompt = buildRaceJudgePrompt({
      projectName: "ado",
      rootDir: "/repo",
      phaseName: "Phase 35",
      taskTitle: "Implement judge prompt",
      taskDescription: "Compare race candidates and select one winner.",
      branches: [
        {
          index: 1,
          branchName: "phase-35-race-task-1",
          status: "fulfilled",
          diff: "diff --git a/src/a.ts b/src/a.ts\n+fix",
          stdout: "tests passed",
          stderr: "",
        },
        {
          index: 2,
          branchName: "phase-35-race-task-2",
          status: "rejected",
          diff: "",
          stdout: "",
          stderr: "lint failed",
          error: "process exited with code 1",
        },
      ],
    });

    expect(prompt).toContain("Race Judge");
    expect(prompt).toContain("Task: Implement judge prompt");
    expect(prompt).toContain("Output contract:");
    expect(prompt).toContain("## Candidate 1");
    expect(prompt).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(prompt).toContain("Captured stdout:");
    expect(prompt).toContain("tests passed");
    expect(prompt).toContain("## Candidate 2");
    expect(prompt).toContain("Status: rejected");
    expect(prompt).toContain("Error: process exited with code 1");
    expect(prompt).toContain("(empty)");
  });

  test("rejects duplicate candidate indexes in the judge prompt input", () => {
    expect(() =>
      buildRaceJudgePrompt({
        projectName: "ado",
        rootDir: "/repo",
        phaseName: "Phase 35",
        taskTitle: "Implement judge prompt",
        taskDescription: "Compare race candidates and select one winner.",
        branches: [
          {
            index: 1,
            branchName: "phase-35-race-task-1",
            status: "fulfilled",
            diff: "",
            stdout: "",
            stderr: "",
          },
          {
            index: 1,
            branchName: "phase-35-race-task-2",
            status: "fulfilled",
            diff: "",
            stdout: "",
            stderr: "",
          },
        ],
      }),
    ).toThrow("duplicate index 1");
  });

  test("truncates oversized candidate payloads to keep judge prompts bounded", () => {
    const prompt = buildRaceJudgePrompt({
      projectName: "ado",
      rootDir: "/repo",
      phaseName: "Phase 35",
      taskTitle: "Bound judge prompt",
      taskDescription: "Cap candidate payload sizes before judging.",
      branches: [
        {
          index: 1,
          branchName: "phase-35-race-task-1",
          status: "fulfilled",
          diff: "d".repeat(20_000),
          stdout: "o".repeat(5_000),
          stderr: "e".repeat(5_000),
        },
      ],
    });

    expect(prompt).toContain("[truncated ");
    expect(prompt.length).toBeLessThan(25_000);
  });

  test("includes configurable additional judging instructions", () => {
    const prompt = buildRaceJudgePrompt({
      projectName: "ado",
      rootDir: "/repo",
      phaseName: "Phase 35",
      taskTitle: "Bias selection",
      taskDescription: "Pick the best branch.",
      additionalInstructions:
        "Prefer the candidate that preserves the current UI structure.",
      branches: [
        {
          index: 1,
          branchName: "phase-35-race-task-1",
          status: "fulfilled",
          diff: "",
          stdout: "",
          stderr: "",
        },
      ],
    });

    expect(prompt).toContain("Additional judging instructions:");
    expect(prompt).toContain(
      "Prefer the candidate that preserves the current UI structure.",
    );
  });

  test("parses PICK verdict and trailing reasoning", () => {
    const verdict = parseRaceJudgeVerdict(
      "PICK 2\nReasoning: Candidate 2 is smaller and keeps the existing contract intact.",
      3,
    );

    expect(verdict).toEqual({
      pickedBranchIndex: 2,
      reasoning:
        "Candidate 2 is smaller and keeps the existing contract intact.",
    });
  });

  test("parses inline reasoning on the verdict line", () => {
    const verdict = parseRaceJudgeVerdict(
      "Analysis\nPICK 1: Best diff and clean output",
      2,
    );

    expect(verdict).toEqual({
      pickedBranchIndex: 1,
      reasoning: "Best diff and clean output",
    });
  });

  test("combines inline and trailing reasoning while stripping labels", () => {
    const verdict = parseRaceJudgeVerdict(
      "Notes\npick 2 - Smaller diff\nReasoning: Keeps the existing contract intact.",
      2,
    );

    expect(verdict).toEqual({
      pickedBranchIndex: 2,
      reasoning: "Smaller diff\nKeeps the existing contract intact.",
    });
  });

  test("rejects out-of-range verdict indexes", () => {
    expect(() => parseRaceJudgeVerdict("PICK 4\nToo many", 3)).toThrow(
      "out of range",
    );
  });

  test("rejects verdicts without reasoning", () => {
    expect(() => parseRaceJudgeVerdict("PICK 1", 2)).toThrow(
      "include reasoning",
    );
  });
});

import { describe, expect, test } from "bun:test";

import { inferTaskType } from "./task-type-classifier";

describe("task-type-classifier", () => {
  test("infers test-writing from test keywords", () => {
    const inferred = inferTaskType({
      title: "Write regression tests for phase-runner",
      description: "Add unit test coverage for task selection edge cases.",
    });

    expect(inferred).toBe("test-writing");
  });

  test("infers code-review from review keywords", () => {
    const inferred = inferTaskType({
      title: "Review PR #42 for branch handling",
      description: "Perform a peer review and list concrete findings.",
    });

    expect(inferred).toBe("code-review");
  });

  test("infers security-audit from security keywords", () => {
    const inferred = inferTaskType({
      title: "Security hardening for webhook endpoint",
      description: "Audit auth checks and identify vulnerabilities.",
    });

    expect(inferred).toBe("security-audit");
  });

  test("infers documentation from docs keywords", () => {
    const inferred = inferTaskType({
      title: "Update docs for semantic routing",
      description: "Refresh README guidance for adapter affinities.",
    });

    expect(inferred).toBe("documentation");
  });

  test("infers implementation from implementation keywords", () => {
    const inferred = inferTaskType({
      title: "Implement phase lock guardrails",
      description: "Add deterministic lock acquisition in phase-runner.",
    });

    expect(inferred).toBe("implementation");
  });

  test("returns undefined when no keyword matches", () => {
    const inferred = inferTaskType({
      title: "Handle item queue",
      description: "Process pending entries in deterministic order.",
    });

    expect(inferred).toBeUndefined();
  });

  test("uses deterministic precedence when multiple types match", () => {
    const inferred = inferTaskType({
      title: "Security review for adapter auth flow",
      description: "Review the threat model and hardening checklist.",
    });

    expect(inferred).toBe("security-audit");
  });

  test("uses both title and description for keyword matching", () => {
    const inferred = inferTaskType({
      title: "Handle semantic routing task",
      description:
        "This task writes new integration tests for classifier flow.",
    });

    expect(inferred).toBe("test-writing");
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, test, expect } from "bun:test";
import { PrCiGate } from "./pr-ci-gate";
import type { GateContext } from "./gate";
import type { VcsProvider } from "../vcs/vcs-provider";
import type { CiStatusSummary } from "../vcs/github-manager";

const baseContext: GateContext = {
  phaseId: "phase-1",
  phaseName: "Test Phase",
  phase: {
    id: "phase-1",
    name: "Test Phase",
    status: "AWAITING_CI",
    branchName: "test-branch",
    tasks: [],
  } as any,
  cwd: "/tmp/project",
  baseBranch: "main",
  headBranch: "test-branch",
  vcsProviderType: "github",
  prUrl: "https://github.com/org/repo/pull/42",
  prNumber: 42,
};

function mockVcsProvider(summary: CiStatusSummary): VcsProvider {
  return {
    async pushBranch() {},
    async openPr() {
      return "";
    },
    async pollChecks() {
      return summary;
    },
    async markReady() {},
    async mergePr() {},
  };
}

function throwingVcsProvider(error: Error): VcsProvider {
  return {
    async pushBranch() {},
    async openPr() {
      return "";
    },
    async pollChecks() {
      throw error;
    },
    async markReady() {},
    async mergePr() {},
  };
}

async function createWorkflowRepo(): Promise<string> {
  const repoDir = await mkdtemp(resolve(tmpdir(), "pr-ci-gate-"));
  const workflowsDir = resolve(repoDir, ".github", "workflows");
  await mkdir(workflowsDir, { recursive: true });
  await writeFile(resolve(workflowsDir, "ci.yml"), "name: CI\non: [push]\n");
  return repoDir;
}

describe("PrCiGate", () => {
  test("passes when all CI checks succeed", async () => {
    const repoDir = await createWorkflowRepo();
    try {
      const gate = new PrCiGate(
        {},
        mockVcsProvider({
          overall: "SUCCESS",
          checks: [
            { name: "lint", state: "SUCCESS" },
            { name: "tests", state: "SUCCESS", detailsUrl: "https://ci/tests" },
          ],
        }),
      );
      const result = await gate.evaluate({ ...baseContext, cwd: repoDir });

      expect(result.passed).toBe(true);
      expect(result.diagnostics).toContain("All CI checks passed");
      expect(result.diagnostics).toContain("lint [SUCCESS]");
      expect(result.diagnostics).toContain("tests [SUCCESS]");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("fails when CI checks fail", async () => {
    const repoDir = await createWorkflowRepo();
    try {
      const gate = new PrCiGate(
        {},
        mockVcsProvider({
          overall: "FAILURE",
          checks: [
            { name: "lint", state: "SUCCESS" },
            {
              name: "tests",
              state: "FAILURE",
              detailsUrl: "https://ci/tests",
            },
          ],
        }),
      );
      const result = await gate.evaluate({ ...baseContext, cwd: repoDir });

      expect(result.passed).toBe(false);
      expect(result.diagnostics).toContain("FAILURE");
      expect(result.diagnostics).toContain("tests [FAILURE]");
      expect(result.retryable).toBe(false);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("retryable when CI is still pending", async () => {
    const repoDir = await createWorkflowRepo();
    try {
      const gate = new PrCiGate(
        {},
        mockVcsProvider({
          overall: "PENDING",
          checks: [{ name: "tests", state: "PENDING" }],
        }),
      );
      const result = await gate.evaluate({ ...baseContext, cwd: repoDir });

      expect(result.passed).toBe(false);
      expect(result.retryable).toBe(true);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("fails without PR number", async () => {
    const gate = new PrCiGate(
      {},
      mockVcsProvider({ overall: "SUCCESS", checks: [] }),
    );
    const noPrContext = { ...baseContext, prNumber: undefined };
    const result = await gate.evaluate(noPrContext);

    expect(result.passed).toBe(false);
    expect(result.diagnostics).toContain("requires a PR number");
    expect(result.retryable).toBe(false);
  });

  test("returns retryable on polling error", async () => {
    const repoDir = await createWorkflowRepo();
    try {
      const gate = new PrCiGate(
        {},
        throwingVcsProvider(new Error("Network timeout")),
      );
      const result = await gate.evaluate({ ...baseContext, cwd: repoDir });

      expect(result.passed).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.diagnostics).toContain("Network timeout");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("passes config through to pollChecks", async () => {
    const repoDir = await createWorkflowRepo();
    try {
      let capturedInput: any;
      const provider: VcsProvider = {
        async pushBranch() {},
        async openPr() {
          return "";
        },
        async pollChecks(input) {
          capturedInput = input;
          return { overall: "SUCCESS", checks: [] };
        },
        async markReady() {},
        async mergePr() {},
      };

      const gate = new PrCiGate(
        {
          intervalMs: 5_000,
          timeoutMs: 60_000,
          terminalConfirmations: 3,
        },
        provider,
      );
      await gate.evaluate({ ...baseContext, cwd: repoDir });

      expect(capturedInput.prNumber).toBe(42);
      expect(capturedInput.intervalMs).toBe(5_000);
      expect(capturedInput.timeoutMs).toBe(60_000);
      expect(capturedInput.terminalConfirmations).toBe(3);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("includes details URL in diagnostics", async () => {
    const repoDir = await createWorkflowRepo();
    try {
      const gate = new PrCiGate(
        {},
        mockVcsProvider({
          overall: "FAILURE",
          checks: [
            {
              name: "e2e",
              state: "FAILURE",
              detailsUrl: "https://ci.example/e2e-run",
            },
          ],
        }),
      );
      const result = await gate.evaluate({ ...baseContext, cwd: repoDir });

      expect(result.diagnostics).toContain("https://ci.example/e2e-run");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("name is pr_ci", () => {
    const gate = new PrCiGate(
      {},
      mockVcsProvider({ overall: "SUCCESS", checks: [] }),
    );
    expect(gate.name).toBe("pr_ci");
  });

  test("passes immediately when branch has no workflow files", async () => {
    const repoDir = await mkdtemp(resolve(tmpdir(), "pr-ci-gate-"));
    try {
      await mkdir(resolve(repoDir, ".github"), { recursive: true });
      let pollCalled = false;
      const provider: VcsProvider = {
        async pushBranch() {},
        async openPr() {
          return "";
        },
        async pollChecks() {
          pollCalled = true;
          return { overall: "PENDING", checks: [] };
        },
        async markReady() {},
        async mergePr() {},
      };

      const gate = new PrCiGate({}, provider);
      const result = await gate.evaluate({ ...baseContext, cwd: repoDir });

      expect(result.passed).toBe(true);
      expect(result.retryable).toBe(false);
      expect(result.diagnostics).toContain("No .github/workflows");
      expect(pollCalled).toBe(false);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("polls CI when branch workflow files exist", async () => {
    const repoDir = await mkdtemp(resolve(tmpdir(), "pr-ci-gate-"));
    try {
      const workflowsDir = resolve(repoDir, ".github", "workflows");
      await mkdir(workflowsDir, { recursive: true });
      await writeFile(
        resolve(workflowsDir, "ci.yml"),
        "name: CI\non: [push]\n",
        "utf8",
      );

      let pollCalled = false;
      const provider: VcsProvider = {
        async pushBranch() {},
        async openPr() {
          return "";
        },
        async pollChecks() {
          pollCalled = true;
          return { overall: "PENDING", checks: [] };
        },
        async markReady() {},
        async mergePr() {},
      };

      const gate = new PrCiGate({}, provider);
      const result = await gate.evaluate({ ...baseContext, cwd: repoDir });

      expect(result.passed).toBe(false);
      expect(result.retryable).toBe(true);
      expect(pollCalled).toBe(true);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

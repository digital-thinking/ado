import { describe, expect, test } from "bun:test";

import { OrchestrationAuthorizationDeniedError } from "../security/orchestration-authorizer";
import { DEFAULT_AUTH_POLICY } from "../security/policy";
import {
  classifyRecoveryException,
  isRecoverableException,
  parseRecoveryResultFromOutput,
  runExceptionRecovery,
  validateRecoveryActions,
} from "./exception-recovery";

import {
  DirtyWorktreeError,
  MissingCommitError,
  AgentFailureError,
} from "../errors";

describe("exception recovery", () => {
  test("classifies dirty tree, commit gap, and agent failure as recoverable", () => {
    const dirtyError = new DirtyWorktreeError();
    const dirty = classifyRecoveryException({
      message: dirtyError.message,
      category: dirtyError.category,
    });

    const commitGapError = new MissingCommitError();
    const commitGap = classifyRecoveryException({
      message: commitGapError.message,
      category: commitGapError.category,
    });

    const agentFailureError = new AgentFailureError("fail");
    const agentFailure = classifyRecoveryException({
      message: agentFailureError.message,
      category: agentFailureError.category,
    });

    expect(dirty.category).toBe("DIRTY_WORKTREE");
    expect(commitGap.category).toBe("MISSING_COMMIT");
    expect(agentFailure.category).toBe("AGENT_FAILURE");
    expect(isRecoverableException(dirty)).toBe(true);
    expect(isRecoverableException(commitGap)).toBe(true);
    expect(isRecoverableException(agentFailure)).toBe(true);
  });

  test("parses strict contract-compliant JSON and rejects invalid payload", () => {
    const parsed = parseRecoveryResultFromOutput(
      '{"status":"fixed","reasoning":"Applied local cleanup","actionsTaken":["git add --all","git commit -m \\"fix\\""],"filesTouched":["src/a.ts"]}',
    );
    expect(parsed.status).toBe("fixed");
    expect(parsed.reasoning).toContain("cleanup");

    expect(() =>
      parseRecoveryResultFromOutput(
        '{"status":"fixed","reasoning":"ok","extra":"not-allowed"}',
      ),
    ).toThrow("contract-compliant JSON");
  });

  test("guardrails allow git add/commit and block git push/rebase", () => {
    expect(() =>
      validateRecoveryActions(["git add --all", 'git commit -m "fix"']),
    ).not.toThrow();
    expect(() => validateRecoveryActions(["git push origin main"])).toThrow(
      "forbidden by policy guardrails",
    );
    expect(() => validateRecoveryActions(["git rebase main"])).toThrow(
      "forbidden by policy guardrails",
    );
  });

  test("returns fixed outcome and structured record", async () => {
    const exception = classifyRecoveryException({
      message: "Git working tree is not clean.",
      category: "DIRTY_WORKTREE",
      phaseId: "11111111-1111-4111-8111-111111111111",
      taskId: "22222222-2222-4222-8222-222222222222",
    });

    const attempt = await runExceptionRecovery({
      cwd: process.cwd(),
      assignee: "MOCK_CLI",
      exception,
      attemptNumber: 1,
      role: "admin",
      policy: DEFAULT_AUTH_POLICY,
      runInternalWork: async () => ({
        stdout:
          '{"status":"fixed","reasoning":"Staged and committed changes","actionsTaken":["git add --all","git commit -m \\"fix\\""],"filesTouched":["src/cli/index.ts"]}',
        stderr: "",
      }),
    });

    expect(attempt.result.status).toBe("fixed");
    expect(attempt.exception.category).toBe("DIRTY_WORKTREE");
    expect(attempt.attemptNumber).toBe(1);
  });

  test("DIRTY_WORKTREE attempt 1 resumes original session with plain nudge and skips JSON parsing", async () => {
    const exception = classifyRecoveryException({
      message: "Git working tree is not clean.",
      category: "DIRTY_WORKTREE",
    });

    let capturedPrompt = "";
    let capturedResume: boolean | undefined;

    const attempt = await runExceptionRecovery({
      cwd: process.cwd(),
      assignee: "MOCK_CLI",
      exception,
      attemptNumber: 1,
      role: "admin",
      policy: DEFAULT_AUTH_POLICY,
      runInternalWork: async (work) => {
        capturedPrompt = work.prompt;
        capturedResume = work.resume;
        return {
          stdout: "non-json freeform model response",
          stderr: "",
        };
      },
    });

    expect(capturedResume).toBe(true);
    expect(capturedPrompt).toBe(
      "You left uncommitted changes. Please `git add` and `git commit` all your work with a descriptive message, then verify the repository is clean.",
    );
    expect(capturedPrompt).not.toContain("Return ONLY strict JSON");
    expect(attempt.result.status).toBe("fixed");
  });

  test("DIRTY_WORKTREE attempt 2 uses recovery-worker JSON prompt and does not resume", async () => {
    const exception = classifyRecoveryException({
      message: "Git working tree is not clean.",
      category: "DIRTY_WORKTREE",
    });

    let capturedPrompt = "";
    let capturedResume: boolean | undefined;

    const attempt = await runExceptionRecovery({
      cwd: process.cwd(),
      assignee: "MOCK_CLI",
      exception,
      attemptNumber: 2,
      role: "admin",
      policy: DEFAULT_AUTH_POLICY,
      runInternalWork: async (work) => {
        capturedPrompt = work.prompt;
        capturedResume = work.resume;
        return {
          stdout:
            '{"status":"fixed","reasoning":"cleaned up","actionsTaken":["git add --all","git commit -m \\"fix\\""],"filesTouched":["src/main.ts"]}',
          stderr: "",
        };
      },
    });

    expect(capturedResume).toBe(false);
    expect(capturedPrompt).toContain("Return ONLY strict JSON");
    expect(capturedPrompt).toContain("Exception category: DIRTY_WORKTREE");
    expect(attempt.result.status).toBe("fixed");
    expect(attempt.result.actionsTaken).toEqual([
      "git add --all",
      'git commit -m "fix"',
    ]);
  });

  test("returns unfixable and denies when role lacks permissions", async () => {
    const exception = classifyRecoveryException({
      message: "Execution loop stopped after FAILED task #2.",
      category: "AGENT_FAILURE",
    });

    const unfixable = await runExceptionRecovery({
      cwd: process.cwd(),
      assignee: "MOCK_CLI",
      exception,
      attemptNumber: 1,
      role: "admin",
      policy: DEFAULT_AUTH_POLICY,
      runInternalWork: async () => ({
        stdout: '{"status":"unfixable","reasoning":"Needs human input"}',
        stderr: "",
      }),
    });
    expect(unfixable.result.status).toBe("unfixable");

    await expect(
      runExceptionRecovery({
        cwd: process.cwd(),
        assignee: "MOCK_CLI",
        exception,
        attemptNumber: 1,
        role: "viewer",
        policy: DEFAULT_AUTH_POLICY,
        runInternalWork: async () => ({
          stdout: '{"status":"fixed","reasoning":"x"}',
          stderr: "",
        }),
      }),
    ).rejects.toBeInstanceOf(OrchestrationAuthorizationDeniedError);
  });
});

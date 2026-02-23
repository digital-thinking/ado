/**
 * P11-003: PrivilegedGitActions wrapper tests.
 *
 * Coverage:
 *   - New primitives: GitManager.rebase(), GitHubManager.mergePullRequest()
 *   - AuthorizationDeniedError carries correct structured properties
 *   - Each gated method: allow paths (owner + admin)
 *   - Each gated method: deny paths (operator + viewer + null role)
 *   - Denylist wins over allowlist (custom policy edge case)
 *   - No underlying runner call is made on deny
 *   - Correct git/gh command args are forwarded on allow
 */

import { describe, expect, test } from "bun:test";

import { AuthorizationDeniedError } from "../security/auth-evaluator";
import {
  ACTIONS,
  DEFAULT_AUTH_POLICY,
  type AuthPolicy,
  type Role,
} from "../security/policy";
import { GitManager } from "./git-manager";
import { GitHubManager } from "./github-manager";
import { PrivilegedGitActions } from "./privileged-git-actions";
import { MockProcessRunner } from "./test-utils";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeWrapper(role: Role | null): {
  pga: PrivilegedGitActions;
  runner: MockProcessRunner;
} {
  const runner = new MockProcessRunner();
  const git = new GitManager(runner);
  const github = new GitHubManager(runner);
  const pga = new PrivilegedGitActions({
    git,
    github,
    role,
    policy: DEFAULT_AUTH_POLICY,
  });
  return { pga, runner };
}

// ---------------------------------------------------------------------------
// New primitive: GitManager.rebase
// ---------------------------------------------------------------------------

describe("GitManager.rebase", () => {
  test("calls git rebase with the onto ref", async () => {
    const runner = new MockProcessRunner();
    const git = new GitManager(runner);

    await git.rebase({ onto: "main", cwd: "/repo" });

    expect(runner.calls[0]).toEqual({
      command: "git",
      args: ["rebase", "main"],
      cwd: "/repo",
    });
  });

  test("accepts any ref string including remote tracking branches", async () => {
    const runner = new MockProcessRunner();
    const git = new GitManager(runner);

    await git.rebase({ onto: "origin/main", cwd: "/repo" });

    expect(runner.calls[0]?.args).toEqual(["rebase", "origin/main"]);
  });

  test("rejects empty onto string", async () => {
    const runner = new MockProcessRunner();
    const git = new GitManager(runner);

    await expect(git.rebase({ onto: "", cwd: "/repo" })).rejects.toThrow(
      "onto must not be empty.",
    );
    await expect(git.rebase({ onto: "   ", cwd: "/repo" })).rejects.toThrow(
      "onto must not be empty.",
    );
  });
});

// ---------------------------------------------------------------------------
// New primitive: GitHubManager.mergePullRequest
// ---------------------------------------------------------------------------

describe("GitHubManager.mergePullRequest", () => {
  test("calls gh pr merge with default --merge flag and --auto", async () => {
    const runner = new MockProcessRunner();
    const manager = new GitHubManager(runner);

    await manager.mergePullRequest({ prNumber: 5, cwd: "/repo" });

    expect(runner.calls[0]).toEqual({
      command: "gh",
      args: ["pr", "merge", "5", "--merge", "--auto"],
      cwd: "/repo",
    });
  });

  test("passes --squash when mergeMethod is squash", async () => {
    const runner = new MockProcessRunner();
    const manager = new GitHubManager(runner);

    await manager.mergePullRequest({
      prNumber: 7,
      cwd: "/repo",
      mergeMethod: "squash",
    });

    expect(runner.calls[0]?.args).toContain("--squash");
    expect(runner.calls[0]?.args).toContain("--auto");
  });

  test("passes --rebase when mergeMethod is rebase", async () => {
    const runner = new MockProcessRunner();
    const manager = new GitHubManager(runner);

    await manager.mergePullRequest({
      prNumber: 3,
      cwd: "/repo",
      mergeMethod: "rebase",
    });

    expect(runner.calls[0]?.args).toContain("--rebase");
  });

  test("rejects prNumber of zero", async () => {
    const runner = new MockProcessRunner();
    const manager = new GitHubManager(runner);

    await expect(
      manager.mergePullRequest({ prNumber: 0, cwd: "/repo" }),
    ).rejects.toThrow("prNumber must be a positive integer.");
  });

  test("rejects negative prNumber", async () => {
    const runner = new MockProcessRunner();
    const manager = new GitHubManager(runner);

    await expect(
      manager.mergePullRequest({ prNumber: -1, cwd: "/repo" }),
    ).rejects.toThrow("prNumber must be a positive integer.");
  });

  test("rejects non-integer prNumber", async () => {
    const runner = new MockProcessRunner();
    const manager = new GitHubManager(runner);

    await expect(
      manager.mergePullRequest({ prNumber: 1.5, cwd: "/repo" }),
    ).rejects.toThrow("prNumber must be a positive integer.");
  });
});

// ---------------------------------------------------------------------------
// AuthorizationDeniedError properties
// ---------------------------------------------------------------------------

describe("AuthorizationDeniedError", () => {
  test("carries role, action, reason, and name from a denylist-match decision", async () => {
    const { pga } = makeWrapper("viewer");

    const err = await pga
      .pushBranch({ branchName: "feat", cwd: "/repo" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(AuthorizationDeniedError);
    const e = err as AuthorizationDeniedError;
    expect(e.name).toBe("AuthorizationDeniedError");
    expect(e.role).toBe("viewer");
    expect(e.action).toBe(ACTIONS.GIT_PUSH);
    expect(e.reason).toBe("denylist-match");
  });

  test("carries null role and no-role reason for unrecognized session", async () => {
    const { pga } = makeWrapper(null);

    const err = await pga
      .pushBranch({ branchName: "feat", cwd: "/repo" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(AuthorizationDeniedError);
    const e = err as AuthorizationDeniedError;
    expect(e.role).toBeNull();
    expect(e.reason).toBe("no-role");
  });

  test("error message includes action name and deny reason", async () => {
    const { pga } = makeWrapper("operator");

    const err = await pga
      .createBranch({ branchName: "feat", cwd: "/repo" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(AuthorizationDeniedError);
    expect((err as AuthorizationDeniedError).message).toMatch(
      ACTIONS.GIT_BRANCH_CREATE,
    );
    expect((err as AuthorizationDeniedError).message).toMatch("denylist-match");
  });
});

// ---------------------------------------------------------------------------
// createBranch
// ---------------------------------------------------------------------------

describe("PrivilegedGitActions.createBranch", () => {
  test("owner: allowed — delegates to git.createBranch with correct args", async () => {
    const { pga, runner } = makeWrapper("owner");

    await pga.createBranch({
      branchName: "phase-11",
      cwd: "/repo",
      fromRef: "main",
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toEqual({
      command: "git",
      args: ["checkout", "-b", "phase-11", "main"],
      cwd: "/repo",
    });
  });

  test("admin: allowed — delegates to git.createBranch", async () => {
    const { pga, runner } = makeWrapper("admin");

    await pga.createBranch({ branchName: "feat", cwd: "/repo" });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.command).toBe("git");
  });

  test("operator: denied — denylist-match, no runner call made", async () => {
    const { pga, runner } = makeWrapper("operator");

    const err = await pga
      .createBranch({ branchName: "feat", cwd: "/repo" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(AuthorizationDeniedError);
    expect((err as AuthorizationDeniedError).reason).toBe("denylist-match");
    expect(runner.calls).toHaveLength(0);
  });

  test("viewer: denied — denylist-match, no runner call made", async () => {
    const { pga, runner } = makeWrapper("viewer");

    await expect(
      pga.createBranch({ branchName: "feat", cwd: "/repo" }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(runner.calls).toHaveLength(0);
  });

  test("null role: denied — no-role, no runner call made", async () => {
    const { pga, runner } = makeWrapper(null);

    const err = await pga
      .createBranch({ branchName: "feat", cwd: "/repo" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(AuthorizationDeniedError);
    expect((err as AuthorizationDeniedError).reason).toBe("no-role");
    expect(runner.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// rebase
// ---------------------------------------------------------------------------

describe("PrivilegedGitActions.rebase", () => {
  test("owner: allowed — delegates to git.rebase with correct args", async () => {
    const { pga, runner } = makeWrapper("owner");

    await pga.rebase({ onto: "main", cwd: "/repo" });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toEqual({
      command: "git",
      args: ["rebase", "main"],
      cwd: "/repo",
    });
  });

  test("admin: allowed — delegates to git.rebase", async () => {
    const { pga, runner } = makeWrapper("admin");

    await pga.rebase({ onto: "origin/main", cwd: "/repo" });

    expect(runner.calls).toHaveLength(1);
  });

  test("operator: denied — denylist-match, no runner call made", async () => {
    const { pga, runner } = makeWrapper("operator");

    await expect(
      pga.rebase({ onto: "main", cwd: "/repo" }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(runner.calls).toHaveLength(0);
  });

  test("viewer: denied — denylist-match, no runner call made", async () => {
    const { pga, runner } = makeWrapper("viewer");

    await expect(
      pga.rebase({ onto: "main", cwd: "/repo" }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(runner.calls).toHaveLength(0);
  });

  test("null role: denied — no-role, no runner call made", async () => {
    const { pga, runner } = makeWrapper(null);

    const err = await pga
      .rebase({ onto: "main", cwd: "/repo" })
      .catch((e) => e);

    expect((err as AuthorizationDeniedError).reason).toBe("no-role");
    expect(runner.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// pushBranch
// ---------------------------------------------------------------------------

describe("PrivilegedGitActions.pushBranch", () => {
  test("owner: allowed — delegates to git.pushBranch with correct args", async () => {
    const { pga, runner } = makeWrapper("owner");

    await pga.pushBranch({ branchName: "phase-11", cwd: "/repo" });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toEqual({
      command: "git",
      args: ["push", "-u", "origin", "phase-11"],
      cwd: "/repo",
    });
  });

  test("admin: allowed — delegates to git.pushBranch", async () => {
    const { pga, runner } = makeWrapper("admin");

    await pga.pushBranch({ branchName: "feat", cwd: "/repo" });

    expect(runner.calls).toHaveLength(1);
  });

  test("operator: denied — denylist-match, correct deny reason", async () => {
    const { pga, runner } = makeWrapper("operator");

    const err = await pga
      .pushBranch({ branchName: "feat", cwd: "/repo" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(AuthorizationDeniedError);
    expect((err as AuthorizationDeniedError).reason).toBe("denylist-match");
    expect(runner.calls).toHaveLength(0);
  });

  test("viewer: denied — no runner call made", async () => {
    const { pga, runner } = makeWrapper("viewer");

    await expect(
      pga.pushBranch({ branchName: "feat", cwd: "/repo" }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(runner.calls).toHaveLength(0);
  });

  test("null role: denied — no-role reason", async () => {
    const { pga, runner } = makeWrapper(null);

    const err = await pga
      .pushBranch({ branchName: "feat", cwd: "/repo" })
      .catch((e) => e);

    expect((err as AuthorizationDeniedError).reason).toBe("no-role");
    expect(runner.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createPullRequest
// ---------------------------------------------------------------------------

describe("PrivilegedGitActions.createPullRequest", () => {
  const prInput = {
    base: "main",
    head: "phase-11",
    title: "Phase 11",
    body: "Implements P11",
    cwd: "/repo",
  };

  test("owner: allowed — delegates and returns PR URL", async () => {
    const { pga, runner } = makeWrapper("owner");
    runner.enqueue({ stdout: "https://github.com/org/repo/pull/99\n" });

    const url = await pga.createPullRequest(prInput);

    expect(url).toBe("https://github.com/org/repo/pull/99");
    expect(runner.calls[0]?.command).toBe("gh");
  });

  test("admin: allowed — delegates and returns URL", async () => {
    const { pga, runner } = makeWrapper("admin");
    runner.enqueue({ stdout: "https://github.com/org/repo/pull/100\n" });

    const url = await pga.createPullRequest(prInput);

    expect(url).toBe("https://github.com/org/repo/pull/100");
  });

  test("operator: denied — denylist-match, no gh call made", async () => {
    const { pga, runner } = makeWrapper("operator");

    await expect(pga.createPullRequest(prInput)).rejects.toBeInstanceOf(
      AuthorizationDeniedError,
    );
    expect(runner.calls).toHaveLength(0);
  });

  test("viewer: denied — no gh call made", async () => {
    const { pga, runner } = makeWrapper("viewer");

    await expect(pga.createPullRequest(prInput)).rejects.toBeInstanceOf(
      AuthorizationDeniedError,
    );
    expect(runner.calls).toHaveLength(0);
  });

  test("null role: denied — no-role reason", async () => {
    const { pga, runner } = makeWrapper(null);

    const err = await pga.createPullRequest(prInput).catch((e) => e);

    expect((err as AuthorizationDeniedError).reason).toBe("no-role");
    expect(runner.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// mergePullRequest
// ---------------------------------------------------------------------------

describe("PrivilegedGitActions.mergePullRequest", () => {
  test("owner: allowed — delegates with default merge method", async () => {
    const { pga, runner } = makeWrapper("owner");

    await pga.mergePullRequest({ prNumber: 42, cwd: "/repo" });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toEqual({
      command: "gh",
      args: ["pr", "merge", "42", "--merge", "--auto"],
      cwd: "/repo",
    });
  });

  test("admin: allowed — delegates with squash method", async () => {
    const { pga, runner } = makeWrapper("admin");

    await pga.mergePullRequest({
      prNumber: 7,
      cwd: "/repo",
      mergeMethod: "squash",
    });

    expect(runner.calls[0]?.args).toContain("--squash");
    expect(runner.calls[0]?.args).toContain("--auto");
  });

  test("admin: allowed — delegates with rebase method", async () => {
    const { pga, runner } = makeWrapper("admin");

    await pga.mergePullRequest({
      prNumber: 3,
      cwd: "/repo",
      mergeMethod: "rebase",
    });

    expect(runner.calls[0]?.args).toContain("--rebase");
  });

  test("operator: denied — denylist-match, no gh call made", async () => {
    const { pga, runner } = makeWrapper("operator");

    await expect(
      pga.mergePullRequest({ prNumber: 1, cwd: "/repo" }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(runner.calls).toHaveLength(0);
  });

  test("viewer: denied — no gh call made", async () => {
    const { pga, runner } = makeWrapper("viewer");

    await expect(
      pga.mergePullRequest({ prNumber: 1, cwd: "/repo" }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(runner.calls).toHaveLength(0);
  });

  test("null role: denied — no-role reason", async () => {
    const { pga, runner } = makeWrapper(null);

    const err = await pga
      .mergePullRequest({ prNumber: 1, cwd: "/repo" })
      .catch((e) => e);

    expect((err as AuthorizationDeniedError).reason).toBe("no-role");
    expect(runner.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Denylist always wins — custom policy edge case
// ---------------------------------------------------------------------------

describe("denylist wins over allowlist", () => {
  test("admin with git:privileged:push explicitly denylisted is denied despite wildcard allowlist", async () => {
    const customPolicy: AuthPolicy = {
      version: "1",
      roles: {
        owner: { allowlist: ["*"], denylist: [] },
        admin: {
          allowlist: ["git:privileged:*"],
          denylist: ["git:privileged:push"], // specific deny over wildcard allow
        },
        operator: { allowlist: ["status:read"], denylist: [] },
        viewer: { allowlist: ["status:read"], denylist: [] },
      },
    };

    const runner = new MockProcessRunner();
    const pga = new PrivilegedGitActions({
      git: new GitManager(runner),
      github: new GitHubManager(runner),
      role: "admin",
      policy: customPolicy,
    });

    // push is denylisted — deny
    const err = await pga
      .pushBranch({ branchName: "feat", cwd: "/repo" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AuthorizationDeniedError);
    expect((err as AuthorizationDeniedError).reason).toBe("denylist-match");
    expect(runner.calls).toHaveLength(0);

    // createBranch is NOT denylisted — the wildcard allowlist still grants it
    await pga.createBranch({ branchName: "feat", cwd: "/repo" });
    expect(runner.calls).toHaveLength(1);
  });
});

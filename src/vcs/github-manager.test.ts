import { describe, expect, test } from "bun:test";

import { ProcessExecutionError } from "../process";
import {
  GitHubManager,
  CiPollingError,
  parsePullRequestNumberFromUrl,
} from "./github-manager";
import { MockProcessRunner } from "./test-utils";

describe("GitHubManager", () => {
  test("lists open issues with metadata", async () => {
    const runner = new MockProcessRunner([
      {
        stdout: JSON.stringify([
          {
            number: 12,
            title: "Stabilize scanner ranking",
            body: "- [ ] Add tests\nTODO: verify weight merge",
            url: "https://github.com/org/repo/issues/12",
            labels: [{ name: "bug" }, { name: "discovery" }],
            createdAt: "2026-03-01T00:00:00.000Z",
            updatedAt: "2026-03-05T00:00:00.000Z",
          },
        ]),
      },
    ]);
    const manager = new GitHubManager(runner);

    const issues = await manager.listOpenIssues({
      cwd: "C:/repo",
      limit: 25,
      labels: ["bug", "discovery"],
    });

    expect(issues).toEqual([
      {
        number: 12,
        title: "Stabilize scanner ranking",
        body: "- [ ] Add tests\nTODO: verify weight merge",
        url: "https://github.com/org/repo/issues/12",
        labels: ["bug", "discovery"],
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-05T00:00:00.000Z",
      },
    ]);
    expect(runner.calls[0]).toEqual({
      command: "gh",
      args: [
        "issue",
        "list",
        "--state",
        "open",
        "--limit",
        "25",
        "--json",
        "number,title,body,url,labels,createdAt,updatedAt",
        "--label",
        "bug,discovery",
      ],
      cwd: "C:/repo",
    });
  });

  test("fails when open issues response is invalid json", async () => {
    const runner = new MockProcessRunner([{ stdout: "{oops}" }]);
    const manager = new GitHubManager(runner);

    await expect(
      manager.listOpenIssues({
        cwd: "C:/repo",
      }),
    ).rejects.toThrow("Unable to parse open issues response");
  });

  test("fails when open issue payload is missing required fields", async () => {
    const runner = new MockProcessRunner([
      {
        stdout: JSON.stringify([
          {
            number: 1,
            title: "",
            url: "https://github.com/org/repo/issues/1",
            createdAt: "2026-03-01T00:00:00.000Z",
            updatedAt: "2026-03-02T00:00:00.000Z",
          },
        ]),
      },
    ]);
    const manager = new GitHubManager(runner);

    await expect(
      manager.listOpenIssues({
        cwd: "C:/repo",
      }),
    ).rejects.toThrow("Issue response contains invalid title");
  });

  test("creates a pull request and returns its URL", async () => {
    const runner = new MockProcessRunner([
      { stdout: "" }, // gh pr list (no existing PR)
      { stdout: "https://github.com/org/repo/pull/42\n" },
    ]);
    const manager = new GitHubManager(runner);

    const url = await manager.createPullRequest({
      base: "main",
      head: "feature/test",
      title: "Test PR",
      body: "Body",
      cwd: "C:/repo",
    });

    expect(url).toBe("https://github.com/org/repo/pull/42");
    expect(runner.calls[1]).toEqual({
      command: "gh",
      args: [
        "pr",
        "create",
        "--base",
        "main",
        "--head",
        "feature/test",
        "--title",
        "Test PR",
        "--body",
        "Body",
      ],
      cwd: "C:/repo",
    });
  });

  test("fails if PR URL cannot be parsed", async () => {
    const runner = new MockProcessRunner([{ stdout: "created\n" }]);
    const manager = new GitHubManager(runner);

    await expect(
      manager.createPullRequest({
        base: "main",
        head: "feature/test",
        title: "Test PR",
        body: "Body",
        cwd: "C:/repo",
      }),
    ).rejects.toThrow("Unable to parse pull request URL");
  });

  test("passes optional template, labels, assignees and draft flags", async () => {
    const runner = new MockProcessRunner([
      { stdout: "" }, // gh pr list (no existing PR)
      { stdout: "https://github.com/org/repo/pull/77\n" },
    ]);
    const manager = new GitHubManager(runner);

    const url = await manager.createPullRequest({
      base: "main",
      head: "phase-23",
      title: "Phase 23",
      body: "Body",
      templatePath: ".github/pull_request_template.md",
      labels: ["ixado", "automation"],
      assignees: ["octocat", "hubot"],
      draft: true,
      cwd: "C:/repo",
    });

    expect(url).toBe("https://github.com/org/repo/pull/77");
    expect(runner.calls[1]?.args).toEqual([
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      "phase-23",
      "--title",
      "Phase 23",
      "--body",
      "Body",
      "--template",
      ".github/pull_request_template.md",
      "--label",
      "ixado,automation",
      "--assignee",
      "octocat,hubot",
      "--draft",
    ]);
  });

  test("marks a draft pull request as ready", async () => {
    const runner = new MockProcessRunner([{ stdout: "" }]);
    const manager = new GitHubManager(runner);

    await manager.markPullRequestReady({ prNumber: 55, cwd: "C:/repo" });

    expect(runner.calls[0]).toEqual({
      command: "gh",
      args: ["pr", "ready", "55"],
      cwd: "C:/repo",
    });
  });

  test("maps CI check status to pending", async () => {
    const runner = new MockProcessRunner([
      {
        stdout: JSON.stringify({
          statusCheckRollup: [{ name: "build", status: "IN_PROGRESS" }],
        }),
      },
    ]);
    const manager = new GitHubManager(runner);

    const summary = await manager.getCiStatus(1, "C:/repo");

    expect(summary.overall).toBe("PENDING");
    expect(summary.checks).toEqual([{ name: "build", state: "PENDING" }]);
  });

  test("maps CI check status to failure", async () => {
    const runner = new MockProcessRunner([
      {
        stdout: JSON.stringify({
          statusCheckRollup: [
            { name: "test", status: "COMPLETED", conclusion: "FAILURE" },
          ],
        }),
      },
    ]);
    const manager = new GitHubManager(runner);

    const summary = await manager.getCiStatus(1, "C:/repo");

    expect(summary.overall).toBe("FAILURE");
    expect(summary.checks).toEqual([{ name: "test", state: "FAILURE" }]);
  });

  test("includes CI check details URL when available", async () => {
    const runner = new MockProcessRunner([
      {
        stdout: JSON.stringify({
          statusCheckRollup: [
            {
              name: "lint",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://ci.example/lint",
            },
          ],
        }),
      },
    ]);
    const manager = new GitHubManager(runner);

    const summary = await manager.getCiStatus(1, "C:/repo");

    expect(summary.checks).toEqual([
      {
        name: "lint",
        state: "FAILURE",
        detailsUrl: "https://ci.example/lint",
      },
    ]);
  });

  test("surfaces gh authentication failures with actionable CI polling message", async () => {
    const runner = new MockProcessRunner([
      new ProcessExecutionError(
        "Command failed with exit code 1: gh pr view 38 --json statusCheckRollup",
        {
          command: "gh",
          args: ["pr", "view", "38", "--json", "statusCheckRollup"],
          cwd: "C:/repo",
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr:
            "error: not logged into any GitHub hosts. Run gh auth login\n",
          durationMs: 1,
        },
      ),
    ]);
    const manager = new GitHubManager(runner);

    try {
      await manager.getCiStatus(38, "C:/repo");
      throw new Error("Expected getCiStatus to throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(CiPollingError);
      expect((error as CiPollingError).retryable).toBe(false);
      expect((error as Error).message).toBe(
        "GitHub CLI authentication failed while polling CI for PR #38. Run 'gh auth status' or 'gh auth login'.",
      );
    }
  });

  test("surfaces gh stderr for generic CI polling failures", async () => {
    const runner = new MockProcessRunner([
      new ProcessExecutionError(
        "Command failed with exit code 1: gh pr view 38 --json statusCheckRollup",
        {
          command: "gh",
          args: ["pr", "view", "38", "--json", "statusCheckRollup"],
          cwd: "C:/repo",
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "GraphQL: API rate limit exceeded\n",
          durationMs: 1,
        },
      ),
    ]);
    const manager = new GitHubManager(runner);

    await expect(manager.getCiStatus(38, "C:/repo")).rejects.toThrow(
      "GitHub CLI failed while polling CI for PR #38: GraphQL: API rate limit exceeded",
    );
  });

  test("polls until CI reaches terminal success state", async () => {
    const runner = new MockProcessRunner([
      {
        stdout: JSON.stringify({
          statusCheckRollup: [{ name: "build", status: "IN_PROGRESS" }],
        }),
      },
      {
        stdout: JSON.stringify({
          statusCheckRollup: [
            { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
          ],
        }),
      },
    ]);
    const manager = new GitHubManager(runner);

    const summary = await manager.pollCiStatus({
      prNumber: 1,
      cwd: "C:/repo",
      intervalMs: 1,
      timeoutMs: 100,
    });

    expect(summary.overall).toBe("SUCCESS");
    expect(runner.calls).toHaveLength(2);
  });

  test("poll reports deterministic transitions and rerun progression", async () => {
    const runner = new MockProcessRunner([
      {
        stdout: JSON.stringify({
          statusCheckRollup: [{ name: "build", status: "IN_PROGRESS" }],
        }),
      },
      {
        stdout: JSON.stringify({
          statusCheckRollup: [
            { name: "build", status: "COMPLETED", conclusion: "FAILURE" },
          ],
        }),
      },
      {
        stdout: JSON.stringify({
          statusCheckRollup: [{ name: "build", status: "IN_PROGRESS" }],
        }),
      },
      {
        stdout: JSON.stringify({
          statusCheckRollup: [
            { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
          ],
        }),
      },
      {
        stdout: JSON.stringify({
          statusCheckRollup: [
            { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
          ],
        }),
      },
    ]);
    const manager = new GitHubManager(runner);
    const transitions: Array<{
      previousOverall: string | null;
      overall: string;
      isRerun: boolean;
      terminalObservationCount: number;
      requiredTerminalObservations: number;
    }> = [];

    const summary = await manager.pollCiStatus({
      prNumber: 1,
      cwd: "C:/repo",
      intervalMs: 1,
      timeoutMs: 200,
      terminalConfirmations: 2,
      onTransition: async (transition) => {
        transitions.push({
          previousOverall: transition.previousOverall,
          overall: transition.overall,
          isRerun: transition.isRerun,
          terminalObservationCount: transition.terminalObservationCount,
          requiredTerminalObservations: transition.requiredTerminalObservations,
        });
      },
    });

    expect(summary.overall).toBe("SUCCESS");
    expect(runner.calls).toHaveLength(5);
    expect(transitions.map((entry) => entry.previousOverall)).toEqual([
      null,
      "PENDING",
      "FAILURE",
      "PENDING",
    ]);
    expect(transitions.map((entry) => entry.overall)).toEqual([
      "PENDING",
      "FAILURE",
      "PENDING",
      "SUCCESS",
    ]);
    expect(transitions[2]?.isRerun).toBe(true);
    expect(transitions[3]?.terminalObservationCount).toBe(1);
    expect(transitions[3]?.requiredTerminalObservations).toBe(2);
  });

  test("parses pull request number from URL", () => {
    expect(
      parsePullRequestNumberFromUrl("https://github.com/org/repo/pull/42"),
    ).toBe(42);
    expect(
      parsePullRequestNumberFromUrl(
        "https://github.com/org/repo/pull/42/files?foo=bar",
      ),
    ).toBe(42);
  });

  test("fails to parse pull request number from invalid URL", () => {
    expect(() =>
      parsePullRequestNumberFromUrl("https://github.com/org/repo/issues/42"),
    ).toThrow("Invalid pull request URL");
  });
});

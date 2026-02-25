import { describe, expect, test } from "bun:test";

import { GitHubManager, parsePullRequestNumberFromUrl } from "./github-manager";
import { MockProcessRunner } from "./test-utils";

describe("GitHubManager", () => {
  test("creates a pull request and returns its URL", async () => {
    const runner = new MockProcessRunner([
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
    expect(runner.calls[0]).toEqual({
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
    expect(runner.calls[0]?.args).toEqual([
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

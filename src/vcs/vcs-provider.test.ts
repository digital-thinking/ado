import { describe, expect, test } from "bun:test";

import { GitManager } from "./git-manager";
import { GitHubManager } from "./github-manager";
import { MockProcessRunner } from "./test-utils";
import type { VcsProvider } from "./vcs-provider";

describe("VcsProvider", () => {
  test("adapts the existing git and GitHub managers behind a shared contract", async () => {
    const runner = new MockProcessRunner([
      { stdout: "" },
      { stdout: "https://github.com/org/repo/pull/77\n" },
      {
        stdout: JSON.stringify({
          statusCheckRollup: [
            { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
          ],
        }),
      },
      { stdout: "" },
      { stdout: "" },
    ]);
    const git = new GitManager(runner);
    const github = new GitHubManager(runner);
    const provider: VcsProvider = {
      pushBranch: git.pushBranch.bind(git),
      openPr: github.createPullRequest.bind(github),
      pollChecks: github.pollCiStatus.bind(github),
      markReady: github.markPullRequestReady.bind(github),
      mergePr: github.mergePullRequest.bind(github),
    };

    await provider.pushBranch({ branchName: "phase-34", cwd: "C:/repo" });
    const prUrl = await provider.openPr({
      base: "main",
      head: "phase-34",
      title: "Phase 34",
      body: "Body",
      cwd: "C:/repo",
    });
    const checks = await provider.pollChecks({
      prNumber: 77,
      cwd: "C:/repo",
      intervalMs: 1,
      timeoutMs: 100,
    });
    await provider.markReady({ prNumber: 77, cwd: "C:/repo" });
    await provider.mergePr({ prNumber: 77, cwd: "C:/repo" });

    expect(prUrl).toBe("https://github.com/org/repo/pull/77");
    expect(checks.overall).toBe("SUCCESS");
    expect(runner.calls).toEqual([
      {
        command: "git",
        args: ["push", "-u", "origin", "phase-34"],
        cwd: "C:/repo",
      },
      {
        command: "gh",
        args: [
          "pr",
          "list",
          "--head",
          "phase-34",
          "--json",
          "url",
          "--jq",
          ".[0].url",
        ],
        cwd: "C:/repo",
      },
      {
        command: "gh",
        args: ["pr", "view", "77", "--json", "statusCheckRollup"],
        cwd: "C:/repo",
      },
      {
        command: "gh",
        args: ["pr", "ready", "77"],
        cwd: "C:/repo",
      },
      {
        command: "gh",
        args: ["pr", "merge", "77", "--merge", "--auto"],
        cwd: "C:/repo",
      },
    ]);
  });
});

import { describe, expect, test } from "bun:test";

import { GitHubProvider } from "./github-provider";
import { LocalProvider } from "./local-provider";
import { NullProvider } from "./null-provider";
import { MockProcessRunner } from "./test-utils";
import {
  UnsupportedVcsProviderOperationError,
  type VcsProvider,
} from "./vcs-provider";

describe("VcsProvider", () => {
  test("GitHubProvider adapts the existing git and GitHub managers behind a shared contract", async () => {
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
    const provider: VcsProvider = new GitHubProvider(runner);

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

  test("LocalProvider only pushes the branch and fails fast on pull request operations", async () => {
    const runner = new MockProcessRunner([{ stdout: "" }]);
    const provider: VcsProvider = new LocalProvider(runner);

    await provider.pushBranch({ branchName: "phase-34", cwd: "C:/repo" });

    await expect(
      provider.openPr({
        base: "main",
        head: "phase-34",
        title: "Phase 34",
        body: "Body",
        cwd: "C:/repo",
      }),
    ).rejects.toBeInstanceOf(UnsupportedVcsProviderOperationError);
    await expect(
      provider.pollChecks({
        prNumber: 77,
        cwd: "C:/repo",
        intervalMs: 1,
        timeoutMs: 100,
      }),
    ).rejects.toThrow("LocalProvider does not support pollChecks.");
    await expect(
      provider.markReady({ prNumber: 77, cwd: "C:/repo" }),
    ).rejects.toThrow("LocalProvider does not support markReady.");
    await expect(
      provider.mergePr({ prNumber: 77, cwd: "C:/repo" }),
    ).rejects.toThrow("LocalProvider does not support mergePr.");

    expect(runner.calls).toEqual([
      {
        command: "git",
        args: ["push", "-u", "origin", "phase-34"],
        cwd: "C:/repo",
      },
    ]);
  });

  test("NullProvider keeps the branch local and rejects remote operations", async () => {
    const runner = new MockProcessRunner();
    const provider: VcsProvider = new NullProvider();

    await provider.pushBranch({ branchName: "phase-34", cwd: "C:/repo" });

    await expect(
      provider.openPr({
        base: "main",
        head: "phase-34",
        title: "Phase 34",
        body: "Body",
        cwd: "C:/repo",
      }),
    ).rejects.toBeInstanceOf(UnsupportedVcsProviderOperationError);
    await expect(
      provider.pollChecks({
        prNumber: 77,
        cwd: "C:/repo",
        intervalMs: 1,
        timeoutMs: 100,
      }),
    ).rejects.toThrow("NullProvider does not support pollChecks.");
    await expect(
      provider.markReady({ prNumber: 77, cwd: "C:/repo" }),
    ).rejects.toThrow("NullProvider does not support markReady.");
    await expect(
      provider.mergePr({ prNumber: 77, cwd: "C:/repo" }),
    ).rejects.toThrow("NullProvider does not support mergePr.");

    expect(runner.calls).toEqual([]);
  });
});

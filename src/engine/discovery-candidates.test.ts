import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { GitHubIssue } from "../vcs";
import {
  discoverTaskCandidates,
  mergeDiscoveryCandidates,
} from "./discovery-candidates";
import type { TodoFixmeFinding } from "./todo-fixme-scanner";

async function writeTextFile(
  filePath: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

describe("discovery-candidates", () => {
  let sandboxDir: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-discovery-"));
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("merges scanner findings with parsed GitHub issue candidates", () => {
    const todoFindings: TodoFixmeFinding[] = [
      {
        tag: "FIXME",
        text: "stabilize startup sequence",
        filePath: "src/bootstrap.ts",
        line: 12,
        lineText: "// FIXME: stabilize startup sequence",
        frequency: 1,
        recencyScore: 1,
        frequencyScore: 1,
        tagScore: 1,
        priorityScore: 1,
      },
      {
        tag: "TODO",
        text: "clean up stale branch references",
        filePath: "src/vcs/git-manager.ts",
        line: 48,
        lineText: "// TODO: clean up stale branch references",
        frequency: 1,
        recencyScore: 0,
        frequencyScore: 1,
        tagScore: 0.5,
        priorityScore: 0.45,
      },
    ];

    const openIssues: GitHubIssue[] = [
      {
        number: 42,
        title: "Fix CI regression in autonomous discovery",
        body: [
          "- [ ] Add regression test for candidate ranking",
          "TODO: normalize merged candidate ordering",
        ].join("\n"),
        url: "https://github.com/org/repo/issues/42",
        labels: ["bug"],
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-06T00:00:00.000Z",
      },
    ];

    const merged = mergeDiscoveryCandidates({
      todoFindings,
      openIssues,
    });

    expect(merged.length).toBeGreaterThanOrEqual(4);
    expect(
      merged.some((candidate) => candidate.source === "TODO_COMMENT"),
    ).toBe(true);
    expect(
      merged.some((candidate) => candidate.source === "GITHUB_ISSUE"),
    ).toBe(true);
    expect(
      merged.some(
        (candidate) =>
          candidate.source === "GITHUB_ISSUE" &&
          candidate.title === "Add regression test for candidate ranking",
      ),
    ).toBe(true);
    expect(
      merged.some(
        (candidate) =>
          candidate.source === "GITHUB_ISSUE" &&
          candidate.title === "normalize merged candidate ordering",
      ),
    ).toBe(true);

    for (let i = 1; i < merged.length; i += 1) {
      expect(merged[i - 1]?.priorityScore ?? 0).toBeGreaterThanOrEqual(
        merged[i]?.priorityScore ?? 0,
      );
    }
  });

  test("discovers candidates by scanning files and fetching open issues", async () => {
    const sourceFilePath = join(sandboxDir, "src", "main.ts");
    await writeTextFile(
      sourceFilePath,
      "// TODO: implement discover command\n",
    );

    const openIssues: GitHubIssue[] = [
      {
        number: 7,
        title: "TODO discovery should include issues",
        body: "Track discover output in CI logs.",
        url: "https://github.com/org/repo/issues/7",
        labels: [],
        createdAt: "2026-03-02T00:00:00.000Z",
        updatedAt: "2026-03-07T00:00:00.000Z",
      },
    ];

    const calls: Array<{ cwd: string; limit?: number; labels?: string[] }> = [];
    const githubManager = {
      listOpenIssues: async (input: {
        cwd: string;
        limit?: number;
        labels?: string[];
      }) => {
        calls.push(input);
        return openIssues;
      },
    };

    const discovered = await discoverTaskCandidates({
      rootDir: sandboxDir,
      githubManager,
      includePatterns: ["src/**/*.ts"],
      issueLimit: 15,
      issueLabels: ["bug", "discovery"],
    });

    expect(calls).toEqual([
      {
        cwd: sandboxDir,
        limit: 15,
        labels: ["bug", "discovery"],
      },
    ]);
    expect(
      discovered.some((candidate) => candidate.source === "TODO_COMMENT"),
    ).toBe(true);
    expect(
      discovered.some(
        (candidate) =>
          candidate.source === "GITHUB_ISSUE" && candidate.issueNumber === 7,
      ),
    ).toBe(true);
  });
});

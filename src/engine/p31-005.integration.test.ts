import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { GitHubIssue } from "../vcs";
import { discoverTaskCandidates } from "./discovery-candidates";

describe("P31-005 integration: discovery pipeline", () => {
  let sandboxDir: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-p31-005-int-"));
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("extracts scanner comments, maps issues, ranks candidates, and applies maxCandidates", async () => {
    const todoFile = join(sandboxDir, "src", "todo.ts");
    const fixmeFile = join(sandboxDir, "src", "fixme.ts");
    const ignoredFile = join(sandboxDir, "src", "generated", "skip.ts");

    await mkdir(join(sandboxDir, "src", "generated"), { recursive: true });
    await writeFile(
      todoFile,
      "// TODO: normalize discovery formatter\n",
      "utf8",
    );
    await writeFile(fixmeFile, "// FIXME: handle ranking edge case\n", "utf8");
    await writeFile(ignoredFile, "// TODO: should be excluded\n", "utf8");

    const older = new Date("2026-03-01T00:00:00.000Z");
    const newer = new Date("2026-03-08T00:00:00.000Z");
    await utimes(todoFile, older, older);
    await utimes(fixmeFile, newer, newer);

    const openIssues: GitHubIssue[] = [
      {
        number: 88,
        title: "Fix discovery candidate ranking output",
        body: [
          "- [ ] Add integration coverage for discover",
          "TODO: verify deterministic ordering",
        ].join("\n"),
        url: "https://github.com/org/repo/issues/88",
        labels: ["bug"],
        createdAt: "2026-03-03T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ];

    const candidates = await discoverTaskCandidates({
      rootDir: sandboxDir,
      githubManager: {
        listOpenIssues: async () => openIssues,
      },
      includePatterns: ["src/**/*.ts"],
      excludePatterns: ["src/generated/**"],
      maxCandidates: 4,
    });

    expect(candidates).toHaveLength(4);
    expect(
      candidates.some(
        (candidate) =>
          candidate.source === "TODO_COMMENT" &&
          candidate.filePath === "src/fixme.ts",
      ),
    ).toBe(true);
    expect(
      candidates.some(
        (candidate) =>
          candidate.source === "TODO_COMMENT" &&
          candidate.filePath.includes("generated"),
      ),
    ).toBe(false);
    expect(
      candidates.some(
        (candidate) =>
          candidate.source === "GITHUB_ISSUE" &&
          candidate.title === "Add integration coverage for discover",
      ),
    ).toBe(true);
    expect(
      candidates.some(
        (candidate) =>
          candidate.source === "GITHUB_ISSUE" &&
          candidate.title === "verify deterministic ordering",
      ),
    ).toBe(true);

    for (let index = 1; index < candidates.length; index += 1) {
      expect(candidates[index - 1]?.priorityScore ?? 0).toBeGreaterThanOrEqual(
        candidates[index]?.priorityScore ?? 0,
      );
    }
  });
});

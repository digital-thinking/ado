import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { scanTodoFixmeComments } from "./todo-fixme-scanner";

async function writeTextFile(
  filePath: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

describe("todo-fixme-scanner", () => {
  let sandboxDir: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-todo-scan-"));
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("recursively scans files with include/exclude patterns and extracts context", async () => {
    await writeTextFile(
      join(sandboxDir, "src", "app.ts"),
      [
        "export const value = 1;",
        "// TODO: implement parser",
        "const stable = true;",
        "/* FIXME: remove hard-coded value */",
      ].join("\n"),
    );
    await writeTextFile(
      join(sandboxDir, "src", "skip.generated.ts"),
      "// TODO: generated file should be excluded\n",
    );
    await writeTextFile(
      join(sandboxDir, "nested", "module.js"),
      "const x = 1; // TODO: nested follow-up\n",
    );
    await writeTextFile(
      join(sandboxDir, "docs", "notes.md"),
      "# TODO: docs note should not be included by pattern\n",
    );

    const findings = await scanTodoFixmeComments({
      rootDir: sandboxDir,
      includePatterns: ["src/**/*.ts", "nested/**/*.js"],
      excludePatterns: ["**/*.generated.ts"],
    });

    expect(findings).toHaveLength(3);
    const filePaths = findings.map((item) => item.filePath).sort();
    expect(filePaths).toEqual(["nested/module.js", "src/app.ts", "src/app.ts"]);

    const todo = findings.find(
      (item) => item.filePath === "src/app.ts" && item.line === 2,
    );
    expect(todo).toBeDefined();
    expect(todo?.tag).toBe("TODO");
    expect(todo?.text).toBe("implement parser");
    expect(todo?.lineText).toBe("// TODO: implement parser");

    const fixme = findings.find(
      (item) => item.filePath === "src/app.ts" && item.line === 4,
    );
    expect(fixme).toBeDefined();
    expect(fixme?.tag).toBe("FIXME");
    expect(fixme?.text).toBe("remove hard-coded value");

    expect(
      findings.some((item) => item.filePath.endsWith("skip.generated.ts")),
    ).toBe(false);
    expect(
      findings.some((item) => item.filePath.endsWith("docs/notes.md")),
    ).toBe(false);
  });

  test("scores by recency, frequency, and tag weight", async () => {
    const oldFile = join(sandboxDir, "src", "old.ts");
    const newFile = join(sandboxDir, "src", "new.ts");

    await writeTextFile(oldFile, "// TODO: shared follow-up\n");
    await writeTextFile(
      newFile,
      ["// TODO: shared follow-up", "// FIXME: urgent crash"].join("\n"),
    );

    const olderTimestamp = new Date("2025-01-01T00:00:00.000Z");
    const newerTimestamp = new Date("2026-01-01T00:00:00.000Z");
    await utimes(oldFile, olderTimestamp, olderTimestamp);
    await utimes(newFile, newerTimestamp, newerTimestamp);

    const findings = await scanTodoFixmeComments({
      rootDir: sandboxDir,
      includePatterns: ["**/*.ts"],
      excludePatterns: [],
      priorityWeights: {
        recency: 1,
        frequency: 1,
        tags: 1,
      },
      tagWeights: {
        TODO: 1,
        FIXME: 4,
      },
    });

    expect(findings).toHaveLength(3);

    const oldTodo = findings.find(
      (item) => item.filePath === "src/old.ts" && item.tag === "TODO",
    );
    const newTodo = findings.find(
      (item) => item.filePath === "src/new.ts" && item.tag === "TODO",
    );
    const newFixme = findings.find(
      (item) => item.filePath === "src/new.ts" && item.tag === "FIXME",
    );

    expect(oldTodo).toBeDefined();
    expect(newTodo).toBeDefined();
    expect(newFixme).toBeDefined();

    expect(oldTodo?.frequency).toBe(2);
    expect(newTodo?.frequency).toBe(2);
    expect(newFixme?.frequency).toBe(1);

    expect(oldTodo?.recencyScore).toBeCloseTo(0, 5);
    expect(newTodo?.recencyScore).toBeCloseTo(1, 5);
    expect(newFixme?.recencyScore).toBeCloseTo(1, 5);

    expect(newFixme?.priorityScore ?? 0).toBeGreaterThan(
      newTodo?.priorityScore ?? 0,
    );
    expect(newTodo?.priorityScore ?? 0).toBeGreaterThan(
      oldTodo?.priorityScore ?? 0,
    );
  });

  test("fails fast when rootDir is missing", async () => {
    await expect(
      scanTodoFixmeComments({
        rootDir: join(sandboxDir, "missing"),
      }),
    ).rejects.toThrow("Scanner rootDir does not exist");
  });
});

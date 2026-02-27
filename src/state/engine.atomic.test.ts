/**
 * P26-006 – Atomic persistence tests for StateEngine.
 *
 * Verifies that `writeRawState` uses a temp-file + rename strategy so that
 * the on-disk state file is never left in a partially-written state.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StateEngine } from "./engine";

describe("StateEngine atomic persistence (P26-006)", () => {
  let sandboxDir: string;
  let stateFilePath: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-state-atomic-"));
    stateFilePath = join(sandboxDir, "state.json");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("no .tmp file remains after a successful initialize", async () => {
    const engine = new StateEngine(stateFilePath);
    await engine.initialize({ projectName: "test", rootDir: "/tmp/repo" });

    expect(existsSync(`${stateFilePath}.tmp`)).toBe(false);
    expect(existsSync(stateFilePath)).toBe(true);
  });

  test("no .tmp file remains after a successful writeProjectState", async () => {
    const engine = new StateEngine(stateFilePath);
    const state = await engine.initialize({
      projectName: "v1",
      rootDir: "/tmp/repo",
    });
    await engine.writeProjectState({ ...state, projectName: "v2" });

    expect(existsSync(`${stateFilePath}.tmp`)).toBe(false);
  });

  test("second write replaces first with the correct content", async () => {
    const engine = new StateEngine(stateFilePath);
    const state = await engine.initialize({
      projectName: "v1",
      rootDir: "/tmp/repo",
    });
    await engine.writeProjectState({ ...state, projectName: "v2" });

    const loaded = await engine.readProjectState();
    expect(loaded.projectName).toBe("v2");
  });

  test("state file contains valid JSON after each write", async () => {
    const engine = new StateEngine(stateFilePath);
    await engine.initialize({ projectName: "test", rootDir: "/tmp/repo" });

    const raw = await readFile(stateFilePath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("sequential writes all produce valid, readable state", async () => {
    const engine = new StateEngine(stateFilePath);
    let state = await engine.initialize({ projectName: "p0", rootDir: "/r" });

    for (let i = 1; i <= 5; i++) {
      state = await engine.writeProjectState({
        ...state,
        projectName: `p${i}`,
      });
      const loaded = await engine.readProjectState();
      expect(loaded.projectName).toBe(`p${i}`);
      expect(existsSync(`${stateFilePath}.tmp`)).toBe(false);
    }
  });

  test("write creates parent directory if it does not exist", async () => {
    const nestedPath = join(sandboxDir, "sub", "dir", "state.json");
    const engine = new StateEngine(nestedPath);
    await engine.initialize({ projectName: "nested", rootDir: "/r" });

    expect(existsSync(nestedPath)).toBe(true);
    expect(existsSync(`${nestedPath}.tmp`)).toBe(false);
  });
});

import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  loadCliSettings,
  saveCliSettings,
  resolveGlobalSettingsFilePath,
} from "./settings";
import type { CliSettings } from "../types";

const DEFAULT_AGENT_SETTINGS = {
  CODEX_CLI: { enabled: true, timeoutMs: 3_600_000 },
  CLAUDE_CLI: { enabled: true, timeoutMs: 3_600_000 },
  GEMINI_CLI: { enabled: true, timeoutMs: 3_600_000 },
  MOCK_CLI: { enabled: true, timeoutMs: 3_600_000 },
};

const DEFAULT_LOOP_SETTINGS = {
  autoMode: false,
  countdownSeconds: 10,
  testerCommand: "npm",
  testerArgs: ["run", "test"],
  testerTimeoutMs: 600000,
  ciEnabled: false,
  ciBaseBranch: "main",
  validationMaxRetries: 3,
};
const DEFAULT_EXCEPTION_RECOVERY_SETTINGS = {
  maxAttempts: 1,
};
const DEFAULT_USAGE_SETTINGS = {
  codexbarEnabled: true,
};

function makeSettings(overrides: Partial<CliSettings> = {}): CliSettings {
  return {
    projects: [],
    telegram: { enabled: false },
    internalWork: { assignee: "CODEX_CLI" },
    executionLoop: DEFAULT_LOOP_SETTINGS,
    exceptionRecovery: DEFAULT_EXCEPTION_RECOVERY_SETTINGS,
    usage: DEFAULT_USAGE_SETTINGS,
    agents: DEFAULT_AGENT_SETTINGS,
    ...overrides,
  };
}

describe("multi-project management", () => {
  let sandboxDir: string;
  let globalSettingsFilePath: string;
  const originalGlobalConfigPath = process.env.IXADO_GLOBAL_CONFIG_FILE;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-multi-project-"));
    globalSettingsFilePath = join(sandboxDir, "global-config.json");
    process.env.IXADO_GLOBAL_CONFIG_FILE = globalSettingsFilePath;
  });

  afterEach(async () => {
    if (originalGlobalConfigPath === undefined) {
      delete process.env.IXADO_GLOBAL_CONFIG_FILE;
    } else {
      process.env.IXADO_GLOBAL_CONFIG_FILE = originalGlobalConfigPath;
    }
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("saves and loads projects in global config", async () => {
    const settings = makeSettings({
      projects: [
        { name: "alpha", rootDir: "/tmp/alpha" },
        { name: "beta", rootDir: "/tmp/beta" },
      ],
    });

    await saveCliSettings(globalSettingsFilePath, settings);
    const loaded = await loadCliSettings(globalSettingsFilePath);

    expect(loaded.projects).toEqual([
      { name: "alpha", rootDir: "/tmp/alpha" },
      { name: "beta", rootDir: "/tmp/beta" },
    ]);
  });

  test("saves and loads activeProject in global config", async () => {
    const settings = makeSettings({
      projects: [
        { name: "alpha", rootDir: "/tmp/alpha" },
        { name: "beta", rootDir: "/tmp/beta" },
      ],
      activeProject: "beta",
    });

    await saveCliSettings(globalSettingsFilePath, settings);
    const loaded = await loadCliSettings(globalSettingsFilePath);

    expect(loaded.activeProject).toBe("beta");
  });

  test("activeProject defaults to undefined when not set", async () => {
    const settings = makeSettings({
      projects: [{ name: "alpha", rootDir: "/tmp/alpha" }],
    });

    await saveCliSettings(globalSettingsFilePath, settings);
    const loaded = await loadCliSettings(globalSettingsFilePath);

    expect(loaded.activeProject).toBeUndefined();
  });

  test("registers a new project by pushing to projects array", async () => {
    const settings = makeSettings();
    await saveCliSettings(globalSettingsFilePath, settings);

    const loaded = await loadCliSettings(globalSettingsFilePath);
    loaded.projects.push({ name: "new-project", rootDir: "/tmp/new-project" });
    await saveCliSettings(globalSettingsFilePath, loaded);

    const reloaded = await loadCliSettings(globalSettingsFilePath);
    expect(reloaded.projects).toEqual([
      { name: "new-project", rootDir: "/tmp/new-project" },
    ]);
  });

  test("does not duplicate projects with the same rootDir", async () => {
    const settings = makeSettings({
      projects: [{ name: "existing", rootDir: "/tmp/existing" }],
    });
    await saveCliSettings(globalSettingsFilePath, settings);

    const loaded = await loadCliSettings(globalSettingsFilePath);
    const duplicate = loaded.projects.find(
      (p) => p.rootDir === "/tmp/existing",
    );
    expect(duplicate).toBeDefined();
    expect(duplicate!.name).toBe("existing");
  });

  test("switching active project persists to global config", async () => {
    const settings = makeSettings({
      projects: [
        { name: "alpha", rootDir: "/tmp/alpha" },
        { name: "beta", rootDir: "/tmp/beta" },
      ],
    });
    await saveCliSettings(globalSettingsFilePath, settings);

    const loaded = await loadCliSettings(globalSettingsFilePath);
    loaded.activeProject = "alpha";
    await saveCliSettings(globalSettingsFilePath, loaded);

    const reloaded = await loadCliSettings(globalSettingsFilePath);
    expect(reloaded.activeProject).toBe("alpha");

    reloaded.activeProject = "beta";
    await saveCliSettings(globalSettingsFilePath, reloaded);

    const final = await loadCliSettings(globalSettingsFilePath);
    expect(final.activeProject).toBe("beta");
  });

  test("global config activeProject is preserved through merge with local settings", async () => {
    await saveCliSettings(
      globalSettingsFilePath,
      makeSettings({
        projects: [{ name: "alpha", rootDir: "/tmp/alpha" }],
        activeProject: "alpha",
      }),
    );

    const localSettingsFilePath = join(sandboxDir, "local-settings.json");
    await Bun.write(
      localSettingsFilePath,
      JSON.stringify({ executionLoop: { countdownSeconds: 5 } }),
    );

    const loaded = await loadCliSettings(localSettingsFilePath);
    expect(loaded.activeProject).toBe("alpha");
    expect(loaded.projects).toEqual([
      {
        name: "alpha",
        rootDir: "/tmp/alpha",
        executionSettings: {
          autoMode: false,
          defaultAssignee: "CODEX_CLI",
        },
      },
    ]);
    expect(loaded.executionLoop.countdownSeconds).toBe(5);
  });

  test("project state files are isolated per project rootDir", () => {
    const projectA = "/tmp/project-a";
    const projectB = "/tmp/project-b";
    const stateFileA = join(projectA, ".ixado/state.json");
    const stateFileB = join(projectB, ".ixado/state.json");

    expect(stateFileA).not.toBe(stateFileB);
    expect(stateFileA).toContain("project-a");
    expect(stateFileB).toContain("project-b");
  });

  test("migrates runtime config into active project executionSettings once", async () => {
    await saveCliSettings(
      globalSettingsFilePath,
      makeSettings({
        projects: [
          { name: "alpha", rootDir: "/tmp/alpha" },
          { name: "beta", rootDir: "/tmp/beta" },
        ],
        activeProject: "beta",
        internalWork: { assignee: "CLAUDE_CLI" },
        executionLoop: {
          ...DEFAULT_LOOP_SETTINGS,
          autoMode: true,
        },
      }),
    );

    const loaded = await loadCliSettings(globalSettingsFilePath);
    expect(loaded.projects).toEqual([
      { name: "alpha", rootDir: "/tmp/alpha" },
      {
        name: "beta",
        rootDir: "/tmp/beta",
        executionSettings: {
          autoMode: true,
          defaultAssignee: "CLAUDE_CLI",
        },
      },
    ]);

    const persisted = await loadCliSettings(globalSettingsFilePath);
    expect(persisted.projects[1]?.executionSettings).toEqual({
      autoMode: true,
      defaultAssignee: "CLAUDE_CLI",
    });
  });

  test("does not overwrite existing project executionSettings during migration", async () => {
    await saveCliSettings(
      globalSettingsFilePath,
      makeSettings({
        projects: [
          {
            name: "alpha",
            rootDir: "/tmp/alpha",
            executionSettings: {
              autoMode: false,
              defaultAssignee: "GEMINI_CLI",
            },
          },
        ],
        activeProject: "alpha",
        internalWork: { assignee: "CODEX_CLI" },
        executionLoop: {
          ...DEFAULT_LOOP_SETTINGS,
          autoMode: true,
        },
      }),
    );

    const loaded = await loadCliSettings(globalSettingsFilePath);
    expect(loaded.projects[0]?.executionSettings).toEqual({
      autoMode: false,
      defaultAssignee: "GEMINI_CLI",
    });
  });
});

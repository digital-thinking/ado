import { join, basename } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  loadCliSettings,
  saveCliSettings,
  resolveGlobalSettingsFilePath,
} from "./settings";
import type { CliSettings } from "../types";
import { TestSandbox } from "./test-helpers";

const DEFAULT_AGENT_SETTINGS = {
  CODEX_CLI: {
    enabled: true,
    timeoutMs: 3_600_000,
    startupSilenceTimeoutMs: 60_000,
    bypassApprovalsAndSandbox: false,
  },
  CLAUDE_CLI: {
    enabled: true,
    timeoutMs: 3_600_000,
    startupSilenceTimeoutMs: 60_000,
    bypassApprovalsAndSandbox: false,
  },
  GEMINI_CLI: {
    enabled: true,
    timeoutMs: 3_600_000,
    startupSilenceTimeoutMs: 60_000,
    bypassApprovalsAndSandbox: false,
  },
  MOCK_CLI: {
    enabled: true,
    timeoutMs: 3_600_000,
    startupSilenceTimeoutMs: 60_000,
    bypassApprovalsAndSandbox: false,
  },
};

const DEFAULT_LOOP_SETTINGS = {
  autoMode: false,
  countdownSeconds: 10,
  testerCommand: null,
  testerArgs: null,
  testerTimeoutMs: 600000,
  ciEnabled: false,
  ciBaseBranch: "main",
  validationMaxRetries: 3,
  pullRequest: {
    defaultTemplatePath: null,
    templateMappings: [],
    labels: [],
    assignees: [],
    createAsDraft: false,
    markReadyOnApproval: false,
  },
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
    telegram: {
      enabled: false,
      notifications: {
        level: "all",
        suppressDuplicates: true,
      },
    },
    internalWork: { assignee: "CODEX_CLI" },
    executionLoop: DEFAULT_LOOP_SETTINGS,
    exceptionRecovery: DEFAULT_EXCEPTION_RECOVERY_SETTINGS,
    usage: DEFAULT_USAGE_SETTINGS,
    agents: DEFAULT_AGENT_SETTINGS,
    ...overrides,
  };
}

describe("multi-project management", () => {
  let sandbox: TestSandbox;
  const originalGlobalConfigPath = process.env.IXADO_GLOBAL_CONFIG_FILE;

  beforeEach(async () => {
    sandbox = await TestSandbox.create("ixado-multi-project-");
    process.env.IXADO_GLOBAL_CONFIG_FILE = sandbox.globalConfigFile;
  });

  afterEach(async () => {
    if (originalGlobalConfigPath === undefined) {
      delete process.env.IXADO_GLOBAL_CONFIG_FILE;
    } else {
      process.env.IXADO_GLOBAL_CONFIG_FILE = originalGlobalConfigPath;
    }
    await sandbox.cleanup();
  });

  test("saves and loads projects in global config", async () => {
    const settings = makeSettings({
      projects: [
        { name: "alpha", rootDir: "/tmp/alpha" },
        { name: "beta", rootDir: "/tmp/beta" },
      ],
    });

    await saveCliSettings(sandbox.globalConfigFile, settings);
    const loaded = await loadCliSettings(sandbox.globalConfigFile);

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

    await saveCliSettings(sandbox.globalConfigFile, settings);
    const loaded = await loadCliSettings(sandbox.globalConfigFile);

    expect(loaded.activeProject).toBe("beta");
  });

  test("activeProject defaults to undefined when not set", async () => {
    const settings = makeSettings({
      projects: [{ name: "alpha", rootDir: "/tmp/alpha" }],
    });

    await saveCliSettings(sandbox.globalConfigFile, settings);
    const loaded = await loadCliSettings(sandbox.globalConfigFile);

    expect(loaded.activeProject).toBeUndefined();
  });

  test("registers a new project by pushing to projects array", async () => {
    const settings = makeSettings();
    await saveCliSettings(sandbox.globalConfigFile, settings);

    const loaded = await loadCliSettings(sandbox.globalConfigFile);
    loaded.projects.push({ name: "new-project", rootDir: "/tmp/new-project" });
    await saveCliSettings(sandbox.globalConfigFile, loaded);

    const reloaded = await loadCliSettings(sandbox.globalConfigFile);
    expect(reloaded.projects).toEqual([
      { name: "new-project", rootDir: "/tmp/new-project" },
    ]);
  });

  test("does not duplicate projects with the same rootDir", async () => {
    const settings = makeSettings({
      projects: [{ name: "existing", rootDir: "/tmp/existing" }],
    });
    await saveCliSettings(sandbox.globalConfigFile, settings);

    const loaded = await loadCliSettings(sandbox.globalConfigFile);
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
    await saveCliSettings(sandbox.globalConfigFile, settings);

    const loaded = await loadCliSettings(sandbox.globalConfigFile);
    loaded.activeProject = "alpha";
    await saveCliSettings(sandbox.globalConfigFile, loaded);

    const reloaded = await loadCliSettings(sandbox.globalConfigFile);
    expect(reloaded.activeProject).toBe("alpha");

    reloaded.activeProject = "beta";
    await saveCliSettings(sandbox.globalConfigFile, reloaded);

    const final = await loadCliSettings(sandbox.globalConfigFile);
    expect(final.activeProject).toBe("beta");
  });

  test("global config activeProject is preserved through merge with local settings", async () => {
    await saveCliSettings(
      sandbox.globalConfigFile,
      makeSettings({
        projects: [{ name: "alpha", rootDir: "/tmp/alpha" }],
        activeProject: "alpha",
      }),
    );

    const localSettingsFilePath = join(
      sandbox.projectDir,
      "local-settings.json",
    );
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
      sandbox.globalConfigFile,
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

    const loaded = await loadCliSettings(sandbox.globalConfigFile);
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

    const persisted = await loadCliSettings(sandbox.globalConfigFile);
    expect(persisted.projects[1]?.executionSettings).toEqual({
      autoMode: true,
      defaultAssignee: "CLAUDE_CLI",
    });
  });

  test("does not overwrite existing project executionSettings during migration", async () => {
    await saveCliSettings(
      sandbox.globalConfigFile,
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

    const loaded = await loadCliSettings(sandbox.globalConfigFile);
    expect(loaded.projects[0]?.executionSettings).toEqual({
      autoMode: false,
      defaultAssignee: "GEMINI_CLI",
    });
  });
});

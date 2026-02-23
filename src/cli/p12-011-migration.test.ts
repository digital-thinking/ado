import { describe, expect, test } from "bun:test";
import {
  migrateRuntimeConfigToActiveProject,
  DEFAULT_CLI_SETTINGS,
} from "./settings";
import { ProjectRecordSchema } from "../types";

describe("P12-011: ProjectRecord migration and schema", () => {
  test("ProjectRecordSchema validates executionSettings", () => {
    const valid = {
      name: "test",
      rootDir: "/tmp/test",
      executionSettings: {
        autoMode: true,
        defaultAssignee: "CODEX_CLI",
      },
    };
    expect(ProjectRecordSchema.parse(valid)).toEqual(valid as any);
  });

  test("migrateRuntimeConfigToActiveProject migrates when executionSettings are missing", () => {
    const settings = {
      ...DEFAULT_CLI_SETTINGS,
      activeProject: "alpha",
      projects: [{ name: "alpha", rootDir: "/tmp/alpha" }],
      internalWork: { assignee: "CLAUDE_CLI" as const },
      executionLoop: {
        ...DEFAULT_CLI_SETTINGS.executionLoop,
        autoMode: true,
      },
    };

    const { settings: migrated, migrated: didMigrate } =
      migrateRuntimeConfigToActiveProject(settings);

    expect(didMigrate).toBe(true);
    expect(migrated.projects[0].executionSettings).toEqual({
      autoMode: true,
      defaultAssignee: "CLAUDE_CLI",
    });
  });

  test("migrateRuntimeConfigToActiveProject does nothing if executionSettings already exist", () => {
    const settings = {
      ...DEFAULT_CLI_SETTINGS,
      activeProject: "alpha",
      projects: [
        {
          name: "alpha",
          rootDir: "/tmp/alpha",
          executionSettings: {
            autoMode: false,
            defaultAssignee: "GEMINI_CLI" as const,
          },
        },
      ],
      internalWork: { assignee: "CODEX_CLI" as const },
      executionLoop: {
        ...DEFAULT_CLI_SETTINGS.executionLoop,
        autoMode: true,
      },
    };

    const { migrated: didMigrate } =
      migrateRuntimeConfigToActiveProject(settings);
    expect(didMigrate).toBe(false);
  });

  test("migrateRuntimeConfigToActiveProject does nothing if no active project", () => {
    const settings = {
      ...DEFAULT_CLI_SETTINGS,
      activeProject: undefined,
      projects: [{ name: "alpha", rootDir: "/tmp/alpha" }],
    };

    const { migrated: didMigrate } =
      migrateRuntimeConfigToActiveProject(settings);
    expect(didMigrate).toBe(false);
  });
});

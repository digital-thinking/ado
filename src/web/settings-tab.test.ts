import { expect, test, describe } from "bun:test";
import { createWebApp } from "./app";
import type { CLIAdapterId } from "../types";

describe("settings tab frontend (P12-008)", () => {
  async function getHtml(): Promise<string> {
    const app = createWebApp({
      defaultAgentCwd: "/tmp",
      control: {
        getState: async () => ({}) as never,
        createPhase: async () => ({}) as never,
        createTask: async () => ({}) as never,
        setActivePhase: async () => ({}) as never,
        startTask: async () => ({}) as never,
        resetTaskToTodo: async () => ({}) as never,
        failTaskIfInProgress: async () => ({}) as never,
        importFromTasksMarkdown: async () => ({}) as never,
        runInternalWork: async () => ({}) as never,
      } as never,
      agents: {
        list: () => [],
        start: () => ({}) as never,
        assign: () => ({}) as never,
        kill: () => ({}) as never,
        restart: () => ({}) as never,
        subscribe: () => () => {},
      },
      usage: { getLatest: async () => ({ available: false }) } as never,
      defaultInternalWorkAssignee: "MOCK_CLI",
      defaultAutoMode: false,
      availableWorkerAssignees: ["MOCK_CLI"],
      projectName: "TestProject",
      getRuntimeConfig: async () => ({
        defaultInternalWorkAssignee: "MOCK_CLI" as CLIAdapterId,
        autoMode: false,
      }),
      updateRuntimeConfig: async () => ({
        defaultInternalWorkAssignee: "MOCK_CLI" as CLIAdapterId,
        autoMode: false,
      }),
      getProjects: async () => [],
      getProjectState: async () => ({}) as never,
      updateProjectSettings: async () => ({}) as never,
      getGlobalSettings: async () => ({}) as never,
      updateGlobalSettings: async () => ({}) as never,
      webLogFilePath: "/tmp/web.log",
      cliLogFilePath: "/tmp/cli.log",
    });
    const response = await app.fetch(new Request("http://localhost/"));
    return response.text();
  }

  test("HTML contains Telegram section with expected fields", async () => {
    const html = await getHtml();
    expect(html).toContain('id="telegramSettingsForm"');
    expect(html).toContain('id="telegramEnabled"');
    expect(html).toContain('id="telegramBotToken"');
    expect(html).toContain('id="telegramOwnerId"');
  });

  test("HTML contains Adapters section with dynamic list container", async () => {
    const html = await getHtml();
    expect(html).toContain('id="adaptersSettingsList"');
    expect(html).toContain('id="saveAdaptersButton"');
  });

  test("HTML contains Global Defaults section with expected fields", async () => {
    const html = await getHtml();
    expect(html).toContain('id="globalDefaultsForm"');
    expect(html).toContain('id="globalAutoMode"');
    expect(html).toContain('id="globalDefaultAssignee"');
  });

  test("HTML includes refreshSettings function to populate fields", async () => {
    const html = await getHtml();
    expect(html).toContain("refreshSettings");
    expect(html).toContain("/api/settings");
  });

  test("HTML includes event listeners for save buttons", async () => {
    const html = await getHtml();
    expect(html).toContain(
      'document.getElementById("telegramSettingsForm").addEventListener("submit"',
    );
    expect(html).toContain(
      'document.getElementById("globalDefaultsForm").addEventListener("submit"',
    );
    expect(html).toContain(
      'document.getElementById("saveAdaptersButton").addEventListener("click"',
    );
  });
});

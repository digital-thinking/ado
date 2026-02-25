import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { CommandRegistry } from "./command-registry";
import { ValidationError } from "./validation";

// Capture console.info output
const infoOutput: string[] = [];
const originalInfo = console.info;

describe("P21-005 Snapshot Tests", () => {
  beforeEach(() => {
    infoOutput.length = 0;
    console.info = (...args: any[]) => {
      infoOutput.push(args.join(" "));
    };
  });

  afterAll(() => {
    console.info = originalInfo;
  });

  const registry = new CommandRegistry([
    {
      name: "",
      description: "Run IxADO with stored settings",
    },
    {
      name: "status",
      description: "Show project status and running agents",
    },
    {
      name: "init",
      description: "Register current directory as project in global config",
    },
    {
      name: "list",
      description: "Show all registered projects",
    },
    {
      name: "switch",
      description: "Switch active project context",
      usage: "switch <project-name>",
    },
    {
      name: "onboard",
      description: "Configure global CLI settings",
    },
    {
      name: "task",
      description: "Manage tasks",
      subcommands: [
        {
          name: "list",
          description: "List tasks in active phase with numbers",
        },
        {
          name: "create",
          description: "Create task in active phase",
          usage: "create <title> <description> [assignee]",
        },
        {
          name: "start",
          description: "Start active-phase task",
          usage: "start <taskNumber> [assignee]",
        },
        {
          name: "retry",
          description: "Retry FAILED task with same assignee/session",
          usage: "retry <taskNumber>",
        },
        {
          name: "logs",
          description: "Show logs/result for task in active phase",
          usage: "logs <taskNumber>",
        },
        {
          name: "reset",
          description: "Reset FAILED task to TODO and hard-reset repo",
          usage: "reset <taskNumber>",
        },
      ],
    },
    {
      name: "phase",
      description: "Manage phases",
      subcommands: [
        {
          name: "create",
          description: "Create phase and set it active",
          usage: "create <name> <branchName>",
        },
        {
          name: "active",
          description: "Set active phase",
          usage: "active <phaseNumber|phaseId>",
        },
        {
          name: "run",
          description: "Run TODO/CI_FIX tasks in active phase sequentially",
          usage: "run [auto|manual] [countdownSeconds>=0]",
        },
      ],
    },
    {
      name: "config",
      description: "Manage configuration",
      usage: "config",
      subcommands: [
        {
          name: "show",
          description: "Show current global config",
        },
        {
          name: "mode",
          description: "Set default phase-loop mode",
          usage: "mode <auto|manual>",
        },
        {
          name: "assignee",
          description: "Set default coding CLI",
          usage: "assignee <CLI_ADAPTER>",
        },
        {
          name: "recovery",
          description: "Set exception recovery max attempts",
          usage: "recovery <maxAttempts:0-10>",
        },
        {
          name: "usage",
          description: "Enable/disable codexbar usage telemetry",
          usage: "usage <on|off>",
        },
      ],
    },
    {
      name: "web",
      description: "Manage web control center",
      subcommands: [
        {
          name: "start",
          description: "Start local web control center in background",
          usage: "start [port]",
        },
        {
          name: "stop",
          description: "Stop local web control center",
        },
        {
          name: "serve",
          description: "Run web control center in foreground",
          usage: "serve [port]",
        },
      ],
    },
  ]);

  test("Global help output snapshot", async () => {
    await registry.run(["help"]);
    expect(infoOutput.join("\n")).toMatchSnapshot();
  });

  test("Task command help output snapshot", async () => {
    await registry.run(["task", "help"]);
    expect(infoOutput.join("\n")).toMatchSnapshot();
  });

  test("Config command help output snapshot", async () => {
    await registry.run(["config", "help"]);
    expect(infoOutput.join("\n")).toMatchSnapshot();
  });

  test("ValidationError format snapshot (with usage and hint)", () => {
    const error = new ValidationError("Test error message", {
      usage: "ixado test <arg>",
      hint: "Try adding a valid argument.",
    });
    expect(error.format()).toMatchSnapshot();
  });

  test("ValidationError format snapshot (minimal)", () => {
    const error = new ValidationError("Minimal error");
    expect(error.format()).toMatchSnapshot();
  });
});

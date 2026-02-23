import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { CommandRegistry, type CommandDefinition } from "./command-registry";

describe("CommandRegistry", () => {
  let originalInfo: typeof console.info;
  let infoOutput: string[] = [];

  beforeEach(() => {
    originalInfo = console.info;
    infoOutput = [];
    console.info = mock((...args: any[]) => {
      infoOutput.push(args.join(" "));
    });
  });

  afterEach(() => {
    console.info = originalInfo;
  });

  const testCommands: CommandDefinition[] = [
    {
      name: "task",
      description: "Manage tasks",
      subcommands: [
        {
          name: "list",
          description: "List tasks",
          action: async () => {
            console.info("Listing tasks...");
          },
        },
        {
          name: "create",
          description: "Create a task",
          usage: "create <title>",
          action: async (ctx) => {
            console.info(`Creating task: ${ctx.args[0]}`);
          },
        },
      ],
    },
    {
      name: "config",
      description: "Manage config",
      action: async () => {
        console.info("Config command");
      },
    },
  ];

  test("runs root command", async () => {
    const registry = new CommandRegistry(testCommands);
    await registry.run(["config"]);
    expect(infoOutput).toContain("Config command");
  });

  test("runs subcommand", async () => {
    const registry = new CommandRegistry(testCommands);
    await registry.run(["task", "list"]);
    expect(infoOutput).toContain("Listing tasks...");
  });

  test("runs subcommand with args", async () => {
    const registry = new CommandRegistry(testCommands);
    await registry.run(["task", "create", "New Task"]);
    expect(infoOutput).toContain("Creating task: New Task");
  });

  test("prints global help on no args", async () => {
    const registry = new CommandRegistry(testCommands);
    await registry.run([]);
    const output = infoOutput.join("\n");
    expect(output).toContain("IxADO CLI");
    expect(output).toContain("task list");
    expect(output).toContain("task create <title>");
    expect(output).toContain("config");
  });

  test("prints global help on help command", async () => {
    const registry = new CommandRegistry(testCommands);
    await registry.run(["help"]);
    expect(infoOutput.join("\n")).toContain("IxADO CLI");
  });

  test("prints command help on subcommand help", async () => {
    const registry = new CommandRegistry(testCommands);
    await registry.run(["task", "help"]);
    const output = infoOutput.join("\n");
    expect(output).toContain("Task commands:");
    expect(output).toContain("list");
    expect(output).toContain("create <title>");
  });

  test("throws on unknown command", async () => {
    const registry = new CommandRegistry(testCommands);
    await expect(registry.run(["unknown"])).rejects.toThrow(
      "Unknown command: unknown",
    );
  });
});

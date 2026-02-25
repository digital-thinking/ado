import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { CommandRegistry, type CommandDefinition } from "./command-registry";
import { ValidationError } from "./validation";

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

  test("global help includes hint footer", async () => {
    const registry = new CommandRegistry(testCommands);
    await registry.run([]);
    const output = infoOutput.join("\n");
    expect(output).toContain(
      "Run 'ixado <command> help' for subcommand details.",
    );
  });

  test("global help aligns descriptions with dynamic column width", async () => {
    const registry = new CommandRegistry(testCommands);
    await registry.run([]);
    // The longest usage in testCommands is "task create <title>" (19 chars).
    // Column width = 19 + 2 = 21. Every usage row should be padded to that width.
    const usageLine = infoOutput.find((line) => line.includes("task list"));
    expect(usageLine).toBeDefined();
    // "task list" is 9 chars, padded to 21 → 12 trailing spaces before description
    expect(usageLine).toContain("task list            ");
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

  test("command help includes descriptions", async () => {
    const registry = new CommandRegistry(testCommands);
    await registry.run(["task", "help"]);
    const output = infoOutput.join("\n");
    expect(output).toContain("List tasks");
    expect(output).toContain("Create a task");
  });

  test("command help aligns descriptions with dynamic column width", async () => {
    const registry = new CommandRegistry(testCommands);
    await registry.run(["task", "help"]);
    // Longest usage: "ixado task create <title>" = 25 chars, colWidth = 27.
    // "ixado task list" = 15 chars → padded to 27 → 12 trailing spaces.
    const listLine = infoOutput.find((line) =>
      line.includes("ixado task list"),
    );
    expect(listLine).toBeDefined();
    expect(listLine).toMatch(/ixado task list\s{2,}/);
  });

  test("command help shows blank separator after header", async () => {
    const registry = new CommandRegistry(testCommands);
    await registry.run(["task", "help"]);
    // The line after "Task commands:" should be blank.
    const headerIdx = infoOutput.findIndex((line) => line === "Task commands:");
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(infoOutput[headerIdx + 1]).toBe("");
  });

  test("throws ValidationError on unknown command", async () => {
    const registry = new CommandRegistry(testCommands);
    await expect(registry.run(["unknown"])).rejects.toThrow(ValidationError);
  });

  test("unknown command ValidationError includes quoted name and hint", async () => {
    const registry = new CommandRegistry(testCommands);
    try {
      await registry.run(["nosuchcmd"]);
      expect.assertions(1); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.message).toContain("nosuchcmd");
      expect(ve.hint).toContain("ixado help");
      expect(ve.format()).toContain("Error: Unknown command: 'nosuchcmd'");
      expect(ve.format()).toContain("  Hint:  Run 'ixado help'");
    }
  });
});

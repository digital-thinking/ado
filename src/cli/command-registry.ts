export interface CommandActionContext {
  args: string[]; // Arguments after the command name(s)
  fullArgs: string[]; // All arguments including command name(s)
}

export type CommandAction = (ctx: CommandActionContext) => Promise<void>;

export interface CommandDefinition {
  name: string;
  description: string;
  action?: CommandAction;
  subcommands?: CommandDefinition[];
  usage?: string;
}

export class CommandRegistry {
  private commands: CommandDefinition[] = [];

  constructor(commands: CommandDefinition[] = []) {
    this.commands = commands;
  }

  register(command: CommandDefinition) {
    this.commands.push(command);
  }

  async run(args: string[]): Promise<void> {
    if (args.length === 0) {
      const defaultCmd = this.commands.find((c) => c.name === "");
      if (defaultCmd?.action) {
        await defaultCmd.action({ args: [], fullArgs: args });
        return;
      }
      this.printGlobalHelp();
      return;
    }

    const commandName = args[0];

    if (
      commandName === "help" ||
      commandName === "--help" ||
      commandName === "-h"
    ) {
      this.printGlobalHelp();
      return;
    }

    const command = this.commands.find((c) => c.name === commandName);

    if (!command) {
      throw new Error(`Unknown command: ${commandName}`);
    }

    await this.executeCommand(command, args.slice(1), args);
  }

  private async executeCommand(
    command: CommandDefinition,
    remainingArgs: string[],
    fullArgs: string[],
  ): Promise<void> {
    const subcommandName = remainingArgs[0];

    if (
      subcommandName === "help" ||
      subcommandName === "--help" ||
      subcommandName === "-h"
    ) {
      this.printCommandHelp(command);
      return;
    }

    if (command.subcommands && subcommandName) {
      const subcommand = command.subcommands.find(
        (s) => s.name === subcommandName,
      );
      if (subcommand) {
        await this.executeCommand(subcommand, remainingArgs.slice(1), fullArgs);
        return;
      }
    }

    if (command.action) {
      await command.action({ args: remainingArgs, fullArgs });
      return;
    }

    if (command.subcommands) {
      this.printCommandHelp(command);
      return;
    }

    throw new Error(
      `Command ${command.name} is not executable and has no subcommands.`,
    );
  }

  private printGlobalHelp(): void {
    // Collect all rows first so column width can be computed dynamically.
    const rows: Array<{ usage: string; description: string }> = [];
    for (const cmd of this.commands) {
      if (cmd.name === "") {
        rows.push({ usage: "", description: cmd.description });
        continue;
      }
      if (cmd.subcommands) {
        for (const sub of cmd.subcommands) {
          const usage = sub.usage
            ? `${cmd.name} ${sub.usage}`
            : `${cmd.name} ${sub.name}`;
          rows.push({ usage, description: sub.description });
        }
      } else {
        const usage = cmd.usage || cmd.name;
        rows.push({ usage, description: cmd.description });
      }
    }
    rows.push({ usage: "help", description: "Show this help" });

    const colWidth = Math.max(...rows.map((r) => r.usage.length)) + 2;

    console.info("IxADO CLI");
    console.info("");
    console.info("Usage:");
    for (const row of rows) {
      console.info(`  ixado ${row.usage.padEnd(colWidth)} ${row.description}`);
    }
    console.info("");
    console.info("Run 'ixado <command> help' for subcommand details.");
  }

  private printCommandHelp(command: CommandDefinition): void {
    const label = command.name.charAt(0).toUpperCase() + command.name.slice(1);
    console.info(`${label} commands:`);
    console.info("");
    if (command.subcommands) {
      // Collect rows so column width can be computed dynamically.
      const rows = command.subcommands.map((sub) => ({
        usage: `ixado ${command.name} ${sub.usage || sub.name}`,
        description: sub.description,
      }));
      const colWidth = Math.max(...rows.map((r) => r.usage.length)) + 2;
      for (const row of rows) {
        console.info(`  ${row.usage.padEnd(colWidth)} ${row.description}`);
      }
    } else {
      const usage = `ixado ${command.usage || command.name}`;
      console.info(`  ${usage}  ${command.description}`);
    }
  }
}

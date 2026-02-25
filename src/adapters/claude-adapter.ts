import type { ProcessRunner } from "../process";

import { getRequiredAdapterStartupPolicy } from "./startup";
import { BaseCliAdapter } from "./types";

type ClaudeAdapterOptions = {
  command?: string;
  baseArgs?: string[];
};

const CLAUDE_STARTUP_POLICY = getRequiredAdapterStartupPolicy("CLAUDE_CLI");

export class ClaudeAdapter extends BaseCliAdapter {
  constructor(runner: ProcessRunner, options: ClaudeAdapterOptions = {}) {
    super({
      id: "CLAUDE_CLI",
      command: options.command ?? CLAUDE_STARTUP_POLICY.defaultCommand,
      baseArgs: [
        ...CLAUDE_STARTUP_POLICY.requiredBaseArgs,
        ...(options.baseArgs ?? []),
      ],
      nonInteractiveConfig: CLAUDE_STARTUP_POLICY.nonInteractiveConfig,
      runner,
    });
  }
}

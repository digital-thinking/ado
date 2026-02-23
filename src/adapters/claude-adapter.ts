import type { ProcessRunner } from "../process";

import { BaseCliAdapter, type NonInteractiveConfig } from "./types";

type ClaudeAdapterOptions = {
  command?: string;
  baseArgs?: string[];
};

const REQUIRED_CLAUDE_ARGS = ["--print", "--dangerously-skip-permissions"];

// `--print` puts claude-code into non-interactive batch/print mode.
// There is no specific CLI flag that explicitly requests interactive mode, so
// forbiddenArgs is empty; enforcement is achieved by requiring `--print`.
const CLAUDE_NON_INTERACTIVE_CONFIG: NonInteractiveConfig = {
  requiredArgs: ["--print"],
  forbiddenArgs: [],
};

export class ClaudeAdapter extends BaseCliAdapter {
  constructor(runner: ProcessRunner, options: ClaudeAdapterOptions = {}) {
    super({
      id: "CLAUDE_CLI",
      command: options.command ?? "claude",
      baseArgs: [...REQUIRED_CLAUDE_ARGS, ...(options.baseArgs ?? [])],
      nonInteractiveConfig: CLAUDE_NON_INTERACTIVE_CONFIG,
      runner,
    });
  }
}

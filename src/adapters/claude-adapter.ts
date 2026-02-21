import type { ProcessRunner } from "../process";

import { BaseCliAdapter } from "./types";

type ClaudeAdapterOptions = {
  command?: string;
  baseArgs?: string[];
};

const REQUIRED_CLAUDE_ARGS = ["--print", "--dangerously-skip-permissions"];

export class ClaudeAdapter extends BaseCliAdapter {
  constructor(runner: ProcessRunner, options: ClaudeAdapterOptions = {}) {
    super({
      id: "CLAUDE_CLI",
      command: options.command ?? "claude",
      baseArgs: [...REQUIRED_CLAUDE_ARGS, ...(options.baseArgs ?? [])],
      runner,
    });
  }
}

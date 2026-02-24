import type { ProcessRunner } from "../process";

import { BaseCliAdapter, type NonInteractiveConfig } from "./types";

type CodexAdapterOptions = {
  command?: string;
  baseArgs?: string[];
  bypassApprovalsAndSandbox?: boolean;
};

const REQUIRED_CODEX_ARGS = ["exec"];
const CODEX_BYPASS_FLAG = "--dangerously-bypass-approvals-and-sandbox";

// `exec` is the batch/non-interactive subcommand for codex.
// `chat` and `interactive` are the known interactive subcommands that must
// never appear in the arg list.
const CODEX_NON_INTERACTIVE_CONFIG: NonInteractiveConfig = {
  requiredArgs: ["exec"],
  forbiddenArgs: ["chat", "interactive"],
};

export class CodexAdapter extends BaseCliAdapter {
  constructor(runner: ProcessRunner, options: CodexAdapterOptions = {}) {
    const gatedBypassArgs = options.bypassApprovalsAndSandbox
      ? [CODEX_BYPASS_FLAG]
      : [];

    super({
      id: "CODEX_CLI",
      command: options.command ?? "codex",
      baseArgs: [
        ...REQUIRED_CODEX_ARGS,
        ...gatedBypassArgs,
        ...(options.baseArgs ?? []),
      ],
      nonInteractiveConfig: CODEX_NON_INTERACTIVE_CONFIG,
      runner,
    });
  }
}

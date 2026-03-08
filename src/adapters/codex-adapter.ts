import type { ProcessRunner } from "../process";

import { getRequiredAdapterStartupPolicy } from "./startup";
import { BaseCliAdapter } from "./types";

type CodexAdapterOptions = {
  command?: string;
  baseArgs?: string[];
  bypassApprovalsAndSandbox?: boolean;
};

const CODEX_BYPASS_FLAG = "--dangerously-bypass-approvals-and-sandbox";
const CODEX_STARTUP_POLICY = getRequiredAdapterStartupPolicy("CODEX_CLI");

export class CodexAdapter extends BaseCliAdapter {
  constructor(runner: ProcessRunner, options: CodexAdapterOptions = {}) {
    const gatedBypassArgs = options.bypassApprovalsAndSandbox
      ? [CODEX_BYPASS_FLAG]
      : [];

    super({
      id: "CODEX_CLI",
      command: options.command ?? CODEX_STARTUP_POLICY.defaultCommand,
      baseArgs: [
        ...CODEX_STARTUP_POLICY.requiredBaseArgs,
        ...gatedBypassArgs,
        ...(options.baseArgs ?? []),
      ],
      nonInteractiveConfig: CODEX_STARTUP_POLICY.nonInteractiveConfig,
      runner,
    });
  }
}

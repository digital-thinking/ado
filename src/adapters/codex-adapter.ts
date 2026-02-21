import type { ProcessRunner } from "../process";

import { BaseCliAdapter } from "./types";

type CodexAdapterOptions = {
  command?: string;
  baseArgs?: string[];
};

const REQUIRED_CODEX_ARGS = ["--dangerously-bypass-approvals-and-sandbox"];

export class CodexAdapter extends BaseCliAdapter {
  constructor(runner: ProcessRunner, options: CodexAdapterOptions = {}) {
    super({
      id: "CODEX_CLI",
      command: options.command ?? "codex",
      baseArgs: [...REQUIRED_CODEX_ARGS, ...(options.baseArgs ?? [])],
      runner,
    });
  }
}

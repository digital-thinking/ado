import type { ProcessRunner } from "../process";

import { BaseCliAdapter, type NonInteractiveConfig } from "./types";

type GeminiAdapterOptions = {
  command?: string;
  baseArgs?: string[];
};

const REQUIRED_GEMINI_ARGS = ["--yolo"];

// `--yolo` bypasses all interactive confirmation prompts, putting gemini-cli
// into non-interactive batch mode.  There is no explicit interactive-mode flag
// in the gemini CLI, so forbiddenArgs is empty; enforcement is achieved by
// requiring `--yolo`.
const GEMINI_NON_INTERACTIVE_CONFIG: NonInteractiveConfig = {
  requiredArgs: ["--yolo"],
  forbiddenArgs: [],
};

export class GeminiAdapter extends BaseCliAdapter {
  constructor(runner: ProcessRunner, options: GeminiAdapterOptions = {}) {
    super({
      id: "GEMINI_CLI",
      command: options.command ?? "gemini",
      baseArgs: [...REQUIRED_GEMINI_ARGS, ...(options.baseArgs ?? [])],
      nonInteractiveConfig: GEMINI_NON_INTERACTIVE_CONFIG,
      runner,
    });
  }
}

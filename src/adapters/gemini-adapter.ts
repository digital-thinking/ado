import type { ProcessRunner } from "../process";

import { getRequiredAdapterStartupPolicy } from "./startup";
import { BaseCliAdapter } from "./types";

type GeminiAdapterOptions = {
  command?: string;
  baseArgs?: string[];
};

const GEMINI_STARTUP_POLICY = getRequiredAdapterStartupPolicy("GEMINI_CLI");

export class GeminiAdapter extends BaseCliAdapter {
  constructor(runner: ProcessRunner, options: GeminiAdapterOptions = {}) {
    super({
      id: "GEMINI_CLI",
      command: options.command ?? GEMINI_STARTUP_POLICY.defaultCommand,
      baseArgs: [
        ...GEMINI_STARTUP_POLICY.requiredBaseArgs,
        ...(options.baseArgs ?? []),
      ],
      nonInteractiveConfig: GEMINI_STARTUP_POLICY.nonInteractiveConfig,
      runner,
    });
  }
}

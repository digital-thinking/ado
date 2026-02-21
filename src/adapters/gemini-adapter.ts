import type { ProcessRunner } from "../process";

import { BaseCliAdapter } from "./types";

type GeminiAdapterOptions = {
  command?: string;
  baseArgs?: string[];
};

const REQUIRED_GEMINI_ARGS = ["--yolo"];

export class GeminiAdapter extends BaseCliAdapter {
  constructor(runner: ProcessRunner, options: GeminiAdapterOptions = {}) {
    super({
      id: "GEMINI_CLI",
      command: options.command ?? "gemini",
      baseArgs: [...REQUIRED_GEMINI_ARGS, ...(options.baseArgs ?? [])],
      runner,
    });
  }
}

import type { ProcessRunner } from "../process";
import type { CLIAdapterId } from "../types";

import { ClaudeAdapter } from "./claude-adapter";
import { CodexAdapter } from "./codex-adapter";
import { GeminiAdapter } from "./gemini-adapter";
import { MockCLIAdapter } from "./mock-adapter";
import type { TaskAdapter } from "./types";

type AdapterFactoryOptions = {
  command?: string;
  baseArgs?: string[];
};

export function createAdapter(
  adapterId: CLIAdapterId,
  runner: ProcessRunner,
  options: AdapterFactoryOptions = {}
): TaskAdapter {
  switch (adapterId) {
    case "MOCK_CLI":
      return new MockCLIAdapter(runner, options);
    case "CLAUDE_CLI":
      return new ClaudeAdapter(runner, options);
    case "GEMINI_CLI":
      return new GeminiAdapter(runner, options);
    case "CODEX_CLI":
      return new CodexAdapter(runner, options);
    default: {
      const unreachable: never = adapterId;
      throw new Error(`Unsupported adapter: ${String(unreachable)}`);
    }
  }
}

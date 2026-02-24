import { access } from "node:fs/promises";
import { join } from "node:path";

import { ProcessExecutionError, type ProcessRunner } from "../process";

const DEFAULT_MAX_TESTER_OUTPUT_LENGTH = 4_000;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probes the repository layout to auto-detect a suitable test runner.
 * Returns the command and args to use, or null if no known runner is found.
 *
 * Detection order:
 *  1. package.json present → npm test
 *  2. Makefile present     → make test
 *  3. Otherwise            → null (caller should skip the tester step)
 */
export async function detectTesterCommand(
  cwd: string,
): Promise<{ command: string; args: string[] } | null> {
  if (await fileExists(join(cwd, "package.json"))) {
    return { command: "npm", args: ["test"] };
  }
  if (await fileExists(join(cwd, "Makefile"))) {
    return { command: "make", args: ["test"] };
  }
  return null;
}

export type TesterWorkflowInput = {
  phaseId: string;
  phaseName: string;
  completedTask: {
    id: string;
    title: string;
  };
  cwd: string;
  testerCommand: string | null;
  testerArgs: string[] | null;
  testerTimeoutMs: number;
  runner: ProcessRunner;
  createFixTask: (input: {
    phaseId: string;
    title: string;
    description: string;
    dependencies: string[];
    status: "CI_FIX";
  }) => Promise<void>;
  maxOutputLength?: number;
};

export type TesterWorkflowResult =
  | {
      status: "SKIPPED";
      reason: string;
    }
  | {
      status: "PASSED";
      command: string;
      args: string[];
      output: string;
    }
  | {
      status: "FAILED";
      command: string;
      args: string[];
      errorMessage: string;
      fixTaskTitle: string;
      fixTaskDescription: string;
    };

function truncateOutput(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n\n[truncated]`;
}

function buildFixTaskTitle(triggerTaskTitle: string): string {
  return `Fix tests after ${triggerTaskTitle}`;
}

function buildFixTaskDescription(input: {
  phaseName: string;
  triggerTaskTitle: string;
  command: string;
  args: string[];
  errorMessage: string;
  output: string;
}): string {
  return [
    `Tester workflow failed in ${input.phaseName} after task: ${input.triggerTaskTitle}.`,
    `Command: ${input.command} ${input.args.join(" ")}`.trim(),
    `Error: ${input.errorMessage}`,
    "Test output:",
    input.output || "(no output)",
    "",
    "Fix the failing tests and include validation evidence.",
  ].join("\n");
}

export async function runTesterWorkflow(
  input: TesterWorkflowInput,
): Promise<TesterWorkflowResult> {
  let command = input.testerCommand?.trim() ?? "";
  let args = input.testerArgs ? [...input.testerArgs] : [];
  const maxOutputLength =
    input.maxOutputLength ?? DEFAULT_MAX_TESTER_OUTPUT_LENGTH;

  if (!command && args.length === 0) {
    // Neither command nor args configured — probe the repo for a known test runner.
    const detected = await detectTesterCommand(input.cwd);
    if (!detected) {
      return {
        status: "SKIPPED",
        reason:
          "No tester configured and no known test runner detected (no package.json or Makefile). Skipping tester step.",
      };
    }
    command = detected.command;
    args = detected.args;
  }

  if (!command || args.length === 0) {
    return {
      status: "SKIPPED",
      reason:
        "No tester configured (executionLoop.testerCommand/testerArgs are null). Skipping tester step.",
    };
  }

  try {
    const result = await input.runner.run({
      command,
      args,
      cwd: input.cwd,
      timeoutMs: input.testerTimeoutMs,
    });

    const output = [result.stdout.trim(), result.stderr.trim()]
      .filter((value) => value.length > 0)
      .join("\n\n");

    return {
      status: "PASSED",
      command,
      args,
      output: truncateOutput(output, maxOutputLength),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const output =
      error instanceof ProcessExecutionError
        ? [error.result.stdout.trim(), error.result.stderr.trim()]
            .filter((value) => value.length > 0)
            .join("\n\n")
        : "";
    const truncatedOutput = truncateOutput(output, maxOutputLength);
    const fixTaskTitle = buildFixTaskTitle(input.completedTask.title);
    const fixTaskDescription = buildFixTaskDescription({
      phaseName: input.phaseName,
      triggerTaskTitle: input.completedTask.title,
      command,
      args,
      errorMessage,
      output: truncatedOutput,
    });

    await input.createFixTask({
      phaseId: input.phaseId,
      title: fixTaskTitle,
      description: fixTaskDescription,
      dependencies: [input.completedTask.id],
      status: "CI_FIX",
    });

    return {
      status: "FAILED",
      command,
      args,
      errorMessage,
      fixTaskTitle,
      fixTaskDescription,
    };
  }
}

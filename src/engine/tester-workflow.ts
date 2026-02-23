import { ProcessExecutionError, type ProcessRunner } from "../process";

const DEFAULT_MAX_TESTER_OUTPUT_LENGTH = 4_000;

export type TesterWorkflowInput = {
  phaseId: string;
  phaseName: string;
  completedTask: {
    id: string;
    title: string;
  };
  cwd: string;
  testerCommand: string;
  testerArgs: string[];
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
  const command = input.testerCommand.trim();
  const args = [...input.testerArgs];
  const maxOutputLength =
    input.maxOutputLength ?? DEFAULT_MAX_TESTER_OUTPUT_LENGTH;
  if (!command) {
    throw new Error("testerCommand must not be empty.");
  }
  if (args.length === 0) {
    throw new Error("testerArgs must not be empty.");
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

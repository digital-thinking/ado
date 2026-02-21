import type { CLIAdapterId } from "../types";

export type AdapterExecutionPlan = {
  args: string[];
  stdin?: string;
};

export function buildAdapterExecutionPlan(input: {
  assignee: CLIAdapterId;
  baseArgs: string[];
  prompt: string;
  promptFilePath: string;
  resume: boolean;
}): AdapterExecutionPlan {
  const { assignee, baseArgs, prompt, promptFilePath, resume } = input;

  if (assignee === "CODEX_CLI") {
    if (resume) {
      const withoutExec = baseArgs[0] === "exec" ? baseArgs.slice(1) : baseArgs;
      return {
        args: ["exec", "resume", "--last", ...withoutExec, "-"],
        stdin: prompt,
      };
    }

    return {
      args: [...baseArgs, "-"],
      stdin: prompt,
    };
  }

  if (assignee === "CLAUDE_CLI") {
    return {
      args: resume ? [...baseArgs, "--continue"] : [...baseArgs],
      stdin: prompt,
    };
  }

  if (assignee === "GEMINI_CLI") {
    return {
      args: resume
        ? [...baseArgs, "--resume", "latest", "--prompt", ""]
        : [...baseArgs, "--prompt", ""],
      stdin: prompt,
    };
  }

  return {
    args: [...baseArgs, promptFilePath],
  };
}

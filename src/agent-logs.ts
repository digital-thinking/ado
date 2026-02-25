import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import type { CLIAdapterId } from "./types";
import { resolveGlobalSettingsFilePath } from "./cli/settings";

export type AgentPromptLogArtifacts = {
  inputFilePath: string;
  outputFilePath: string;
};

type CreatePromptLogArtifactsInput = {
  cwd: string;
  assignee: CLIAdapterId;
  prompt: string;
  now?: Date;
};

type WriteOutputLogInput = {
  outputFilePath: string;
  command: string;
  args: string[];
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
};

function toTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export async function createPromptLogArtifacts(
  input: CreatePromptLogArtifactsInput,
): Promise<AgentPromptLogArtifacts> {
  const globalSettingsFilePath = resolveGlobalSettingsFilePath();
  const projectLabel = basename(input.cwd.trim()) || "project";
  const logDir = resolve(
    dirname(globalSettingsFilePath),
    "agent_logs",
    projectLabel,
    input.assignee,
  );
  const timestamp = toTimestamp(input.now ?? new Date());
  const stem = `${timestamp}_${randomUUID().slice(0, 8)}`;
  const inputFilePath = resolve(logDir, `${stem}_in.txt`);
  const outputFilePath = resolve(logDir, `${stem}_out.txt`);

  await mkdir(logDir, { recursive: true });
  await writeFile(inputFilePath, `${input.prompt}\n`, "utf8");

  return {
    inputFilePath,
    outputFilePath,
  };
}

export async function writeOutputLog(
  input: WriteOutputLogInput,
): Promise<void> {
  const lines: string[] = [
    `Command: ${input.command}`,
    `Args: ${input.args.join(" ")}`.trimEnd(),
  ];
  if (typeof input.durationMs === "number") {
    lines.push(`DurationMs: ${input.durationMs}`);
  }
  if (input.errorMessage) {
    lines.push(`Error: ${input.errorMessage}`);
  }
  lines.push("--- STDOUT ---");
  lines.push(input.stdout ?? "");
  lines.push("--- STDERR ---");
  lines.push(input.stderr ?? "");
  lines.push("");

  await writeFile(input.outputFilePath, lines.join("\n"), "utf8");
}

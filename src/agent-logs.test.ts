import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createPromptLogArtifacts, writeOutputLog } from "./agent-logs";

describe("agent logs", () => {
  let sandboxDir: string;
  const originalGlobalConfigPath = process.env.IXADO_GLOBAL_CONFIG_FILE;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-agent-logs-"));
    process.env.IXADO_GLOBAL_CONFIG_FILE = join(
      sandboxDir,
      ".ixado",
      "config.json",
    );
  });

  afterEach(async () => {
    if (originalGlobalConfigPath === undefined) {
      delete process.env.IXADO_GLOBAL_CONFIG_FILE;
    } else {
      process.env.IXADO_GLOBAL_CONFIG_FILE = originalGlobalConfigPath;
    }
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("writes input and output artifacts under global .ixado/agent_logs", async () => {
    const artifacts = await createPromptLogArtifacts({
      cwd: sandboxDir,
      assignee: "CLAUDE_CLI",
      prompt: "Implement task",
      now: new Date("2026-02-21T10:00:00.000Z"),
    });

    expect(artifacts.inputFilePath).toContain(join(sandboxDir, ".ixado"));
    expect(artifacts.inputFilePath).toContain("agent_logs");
    expect(artifacts.inputFilePath).toContain("ixado-agent-logs-");
    expect(artifacts.inputFilePath).toContain("CLAUDE_CLI");
    expect(artifacts.inputFilePath.endsWith("_in.txt")).toBe(true);
    expect(artifacts.outputFilePath.endsWith("_out.txt")).toBe(true);

    const inputBody = await readFile(artifacts.inputFilePath, "utf8");
    expect(inputBody).toContain("Implement task");

    await writeOutputLog({
      outputFilePath: artifacts.outputFilePath,
      command: "claude",
      args: ["--dangerously-skip-permissions", artifacts.inputFilePath],
      durationMs: 12,
      stdout: "done",
      stderr: "",
    });

    const outputBody = await readFile(artifacts.outputFilePath, "utf8");
    expect(outputBody).toContain("Command: claude");
    expect(outputBody).toContain("DurationMs: 12");
    expect(outputBody).toContain("--- STDOUT ---");
    expect(outputBody).toContain("done");
  });
});

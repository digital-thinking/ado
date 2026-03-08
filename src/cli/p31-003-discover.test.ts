import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { TestSandbox } from "./test-helpers";

type RunCliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function runIxadoWithPath(
  args: string[],
  sandbox: TestSandbox,
  pathPrefix: string,
): RunCliResult {
  const sandboxStateFile = join(sandbox.projectDir, ".ixado", "state.json");
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", resolve("src/cli/index.ts"), ...args],
    cwd: sandbox.projectDir,
    env: {
      ...process.env,
      PATH: `${pathPrefix}:${process.env.PATH ?? ""}`,
      IXADO_GLOBAL_CONFIG_FILE: sandbox.globalConfigFile,
      IXADO_STATE_FILE: sandboxStateFile,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

async function installGhStub(
  sandbox: TestSandbox,
  issues: Array<Record<string, unknown>>,
): Promise<string> {
  const binDir = join(sandbox.projectDir, ".test-bin");
  await mkdir(binDir, { recursive: true });
  const ghPath = join(binDir, "gh");
  const payload = JSON.stringify(issues);
  const script = `#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ge 2 ] && [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
${payload}
JSON
  exit 0
fi

echo "unexpected gh invocation: $*" >&2
exit 1
`;
  await writeFile(ghPath, script, "utf8");
  await chmod(ghPath, 0o755);
  return binDir;
}

describe("P31-003 discover command", () => {
  const sandboxes: TestSandbox[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((sandbox) => sandbox.cleanup()));
    sandboxes.length = 0;
  });

  test("dry-run previews merged candidates without queuing tasks", async () => {
    const sandbox = await TestSandbox.create("ixado-p31-003-dry-run-");
    sandboxes.push(sandbox);

    await mkdir(join(sandbox.projectDir, "src"), { recursive: true });
    await writeFile(
      join(sandbox.projectDir, "src", "todo.ts"),
      "// TODO: prepare discover queueing\n",
      "utf8",
    );

    const ghBinDir = await installGhStub(sandbox, [
      {
        number: 13,
        title: "Stabilize discovery output formatting",
        body: "Ensure discover command output is readable.",
        url: "https://github.com/org/repo/issues/13",
        labels: [{ name: "enhancement" }],
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-06T00:00:00.000Z",
      },
    ]);

    const createPhase = runIxadoWithPath(
      ["phase", "create", "Phase 31", "phase-31-autodiscovery"],
      sandbox,
      ghBinDir,
    );
    expect(createPhase.exitCode).toBe(0);

    const discover = runIxadoWithPath(
      ["discover", "--dry-run"],
      sandbox,
      ghBinDir,
    );
    expect(discover.exitCode).toBe(0);
    expect(discover.stderr).toBe("");
    expect(discover.stdout).toContain("Discovered 2 candidate(s).");
    expect(discover.stdout).toContain("Dry run only. No tasks were queued.");

    const state = await sandbox.readProjectState();
    const activePhase = state.phases.find(
      (phase) => phase.id === state.activePhaseId,
    );
    expect(activePhase).toBeDefined();
    expect(activePhase?.tasks).toHaveLength(0);
  });

  test("queue mode adds discovered candidates as TODO tasks in active phase", async () => {
    const sandbox = await TestSandbox.create("ixado-p31-003-queue-");
    sandboxes.push(sandbox);

    await mkdir(join(sandbox.projectDir, "src"), { recursive: true });
    await writeFile(
      join(sandbox.projectDir, "src", "todo.ts"),
      "// FIXME: queue this candidate\n",
      "utf8",
    );

    const ghBinDir = await installGhStub(sandbox, [
      {
        number: 27,
        title: "Fix candidate approval flow",
        body: "Issue candidate for queue mode.",
        url: "https://github.com/org/repo/issues/27",
        labels: [{ name: "bug" }],
        createdAt: "2026-03-02T00:00:00.000Z",
        updatedAt: "2026-03-07T00:00:00.000Z",
      },
    ]);

    const createPhase = runIxadoWithPath(
      ["phase", "create", "Phase 31", "phase-31-autodiscovery"],
      sandbox,
      ghBinDir,
    );
    expect(createPhase.exitCode).toBe(0);

    const discover = runIxadoWithPath(
      ["discover", "--queue"],
      sandbox,
      ghBinDir,
    );
    expect(discover.exitCode).toBe(0);
    expect(discover.stderr).toBe("");
    expect(discover.stdout).toContain(
      "Queued 2 discovery candidate(s) as TODO tasks",
    );

    const state = await sandbox.readProjectState();
    const activePhase = state.phases.find(
      (phase) => phase.id === state.activePhaseId,
    );
    expect(activePhase).toBeDefined();
    expect(activePhase?.tasks).toHaveLength(2);
    expect(activePhase?.tasks.every((task) => task.status === "TODO")).toBe(
      true,
    );
    expect(
      activePhase?.tasks.some((task) => task.title.startsWith("Resolve FIXME")),
    ).toBe(true);
    expect(
      activePhase?.tasks.some((task) => task.title.startsWith("[Issue #27]")),
    ).toBe(true);
  });

  test("queue mode respects discovery.maxCandidates from config", async () => {
    const sandbox = await TestSandbox.create("ixado-p31-003-max-candidates-");
    sandboxes.push(sandbox);

    await Bun.write(
      sandbox.globalConfigFile,
      JSON.stringify({
        discovery: {
          maxCandidates: 1,
        },
      }),
    );

    await mkdir(join(sandbox.projectDir, "src"), { recursive: true });
    await writeFile(
      join(sandbox.projectDir, "src", "todo.ts"),
      "// TODO: candidate one\n// TODO: candidate two\n",
      "utf8",
    );

    const ghBinDir = await installGhStub(sandbox, [
      {
        number: 31,
        title: "Discovery issue candidate",
        body: "One issue candidate.",
        url: "https://github.com/org/repo/issues/31",
        labels: [{ name: "enhancement" }],
        createdAt: "2026-03-03T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
      },
    ]);

    const createPhase = runIxadoWithPath(
      ["phase", "create", "Phase 31", "phase-31-autodiscovery"],
      sandbox,
      ghBinDir,
    );
    expect(createPhase.exitCode).toBe(0);

    const discover = runIxadoWithPath(
      ["discover", "--queue"],
      sandbox,
      ghBinDir,
    );
    expect(discover.exitCode).toBe(0);
    expect(discover.stdout).toContain("Queued 1 discovery candidate(s)");

    const state = await sandbox.readProjectState();
    const activePhase = state.phases.find(
      (phase) => phase.id === state.activePhaseId,
    );
    expect(activePhase).toBeDefined();
    expect(activePhase?.tasks).toHaveLength(1);
  });
});

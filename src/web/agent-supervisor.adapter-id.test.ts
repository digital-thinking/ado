/**
 * P26-007 – Schema-driven adapter-ID parsing in persisted-agent deserialization.
 *
 * Verifies that parsePersistedAgent (tested via registry round-trip) uses
 * CLIAdapterIdSchema to validate adapter IDs rather than a hardcoded allowlist.
 *
 * Covers:
 *  1. All valid CLIAdapterId values are preserved when loaded from the registry.
 *  2. An unknown / misspelled adapter ID is silently dropped (undefined).
 *  3. Missing adapterId is handled gracefully (undefined).
 *  4. Entire record is still returned when adapterId is invalid — only that
 *     field is undefined, the agent is not discarded.
 */

import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { AgentSupervisor } from "./agent-supervisor";
import { CLI_ADAPTER_IDS } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalPersistedAgent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "test-agent-id",
    name: "Test Agent",
    command: "codex",
    args: [],
    cwd: "/tmp",
    status: "STOPPED",
    startedAt: new Date().toISOString(),
    outputTail: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentSupervisor – adapter-ID schema-driven deserialization (P26-007)", () => {
  let sandboxDir: string;
  let registryFilePath: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-supervisor-adapter-id-"));
    registryFilePath = join(sandboxDir, "agents.json");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test.each(CLI_ADAPTER_IDS)(
    "valid adapter ID '%s' is preserved on load",
    (adapterId) => {
      const record = makeMinimalPersistedAgent({ adapterId });
      writeFileSync(registryFilePath, JSON.stringify([record]));

      const supervisor = new AgentSupervisor(() => {
        throw new Error("spawn should not be called");
      }, registryFilePath);

      const agents = supervisor.list();
      expect(agents).toHaveLength(1);
      expect(agents[0].adapterId).toBe(adapterId);
    },
  );

  test("unknown adapter ID is dropped (undefined) but agent is still loaded", () => {
    const record = makeMinimalPersistedAgent({ adapterId: "UNKNOWN_BOT_XYZ" });
    writeFileSync(registryFilePath, JSON.stringify([record]));

    const supervisor = new AgentSupervisor(() => {
      throw new Error("spawn should not be called");
    }, registryFilePath);

    const agents = supervisor.list();
    expect(agents).toHaveLength(1);
    expect(agents[0].adapterId).toBeUndefined();
  });

  test("misspelled adapter ID (wrong case) is dropped but agent is loaded", () => {
    const record = makeMinimalPersistedAgent({ adapterId: "codex_cli" });
    writeFileSync(registryFilePath, JSON.stringify([record]));

    const supervisor = new AgentSupervisor(() => {
      throw new Error("spawn should not be called");
    }, registryFilePath);

    const agents = supervisor.list();
    expect(agents).toHaveLength(1);
    expect(agents[0].adapterId).toBeUndefined();
  });

  test("missing adapterId field is loaded as undefined", () => {
    const record = makeMinimalPersistedAgent();
    // ensure adapterId is absent
    delete (record as Record<string, unknown>)["adapterId"];
    writeFileSync(registryFilePath, JSON.stringify([record]));

    const supervisor = new AgentSupervisor(() => {
      throw new Error("spawn should not be called");
    }, registryFilePath);

    const agents = supervisor.list();
    expect(agents).toHaveLength(1);
    expect(agents[0].adapterId).toBeUndefined();
  });

  test("null adapterId is dropped (undefined) but agent is still loaded", () => {
    const record = makeMinimalPersistedAgent({ adapterId: null });
    writeFileSync(registryFilePath, JSON.stringify([record]));

    const supervisor = new AgentSupervisor(() => {
      throw new Error("spawn should not be called");
    }, registryFilePath);

    const agents = supervisor.list();
    expect(agents).toHaveLength(1);
    expect(agents[0].adapterId).toBeUndefined();
  });
});

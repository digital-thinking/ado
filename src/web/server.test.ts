import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { startWebControlCenter } from "./server";

describe("web server runtime", () => {
  let sandboxDir: string;
  let stateFilePath: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-web-server-"));
    stateFilePath = join(sandboxDir, "state.json");
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("starts server and serves state api", async () => {
    const runtime = await startWebControlCenter({
      cwd: sandboxDir,
      stateFilePath,
      settingsFilePath: join(sandboxDir, "settings.json"),
      projectName: "IxADO",
      defaultInternalWorkAssignee: "MOCK_CLI",
      defaultAutoMode: false,
      agentSettings: {
        CODEX_CLI: { enabled: true, timeoutMs: 3_600_000 },
        CLAUDE_CLI: { enabled: true, timeoutMs: 3_600_000 },
        GEMINI_CLI: { enabled: true, timeoutMs: 3_600_000 },
        MOCK_CLI: { enabled: true, timeoutMs: 3_600_000 },
      },
      webLogFilePath: join(sandboxDir, ".ixado", "web.log"),
      port: 0,
    });

    try {
      const response = await fetch(`${runtime.url}/api/state`);
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.projectName).toBe("IxADO");
      expect(Array.isArray(payload.phases)).toBe(true);
    } finally {
      runtime.stop();
    }
  });
});

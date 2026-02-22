import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadAuthPolicy } from "./policy-loader";
import { DEFAULT_AUTH_POLICY } from "./policy";

describe("policy loader", () => {
  let sandboxDir: string;
  let localSettingsFilePath: string;
  let globalSettingsFilePath: string;
  const originalGlobalConfigPath = process.env.IXADO_GLOBAL_CONFIG_FILE;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "ixado-policy-loader-"));
    localSettingsFilePath = join(sandboxDir, "local-settings.json");
    globalSettingsFilePath = join(sandboxDir, "global-config.json");
    process.env.IXADO_GLOBAL_CONFIG_FILE = globalSettingsFilePath;
  });

  afterEach(async () => {
    if (originalGlobalConfigPath === undefined) {
      delete process.env.IXADO_GLOBAL_CONFIG_FILE;
    } else {
      process.env.IXADO_GLOBAL_CONFIG_FILE = originalGlobalConfigPath;
    }
    await rm(sandboxDir, { recursive: true, force: true });
  });

  test("returns default policy when no policy is configured", async () => {
    const policy = await loadAuthPolicy(localSettingsFilePath);
    expect(policy).toEqual(DEFAULT_AUTH_POLICY);
  });

  test("loads policy from global config", async () => {
    await Bun.write(globalSettingsFilePath, JSON.stringify({
      authorization: {
        policy: DEFAULT_AUTH_POLICY,
      },
    }));

    const policy = await loadAuthPolicy(localSettingsFilePath);
    expect(policy).toEqual(DEFAULT_AUTH_POLICY);
  });

  test("project policy override wins over global policy", async () => {
    await Bun.write(globalSettingsFilePath, JSON.stringify({
      authorization: {
        policy: {
          ...DEFAULT_AUTH_POLICY,
          roles: {
            ...DEFAULT_AUTH_POLICY.roles,
            viewer: {
              ...DEFAULT_AUTH_POLICY.roles.viewer,
              allowlist: ["status:read"],
            },
          },
        },
      },
    }));

    const overridden = {
      ...DEFAULT_AUTH_POLICY,
      roles: {
        ...DEFAULT_AUTH_POLICY.roles,
        viewer: {
          ...DEFAULT_AUTH_POLICY.roles.viewer,
          allowlist: ["tasks:read"],
        },
      },
    };
    await Bun.write(localSettingsFilePath, JSON.stringify({
      authorization: {
        policy: overridden,
      },
    }));

    const policy = await loadAuthPolicy(localSettingsFilePath);
    expect(policy.roles.viewer.allowlist).toEqual(["tasks:read"]);
  });

  test("rejects invalid policy with missing required fields", async () => {
    await Bun.write(localSettingsFilePath, JSON.stringify({
      authorization: {
        policy: {
          version: "1",
          roles: {
            owner: {
              allowlist: ["*"],
              denylist: [],
            },
          },
        },
      },
    }));

    await expect(loadAuthPolicy(localSettingsFilePath)).rejects.toThrow(
      `Invalid authorization policy in ${localSettingsFilePath}`
    );
  });

  test("rejects invalid json", async () => {
    await Bun.write(localSettingsFilePath, "{invalid");

    await expect(loadAuthPolicy(localSettingsFilePath)).rejects.toThrow(
      `Settings file contains invalid JSON: ${localSettingsFilePath}`
    );
  });
});

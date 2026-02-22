import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";

import { z } from "zod";

import { resolveGlobalSettingsFilePath } from "../cli/settings";
import { resolveRole, type RoleResolutionConfig } from "./role-resolver";
import {
  AuthPolicySchema,
  DEFAULT_AUTH_POLICY,
  type AuthPolicy,
} from "./policy";

const PolicyContainerSchema = z.object({
  authorization: z.object({
    policy: AuthPolicySchema,
  }),
});

const RoleConfigContainerSchema = z.object({
  telegram: z.object({
    ownerId: z.number().int().positive().optional(),
  }).optional(),
  authorization: z.object({
    roles: z.object({
      telegramRoles: z.array(z.object({
        userId: z.number().int().positive(),
        role: z.string().min(1),
      })).default([]),
      cliRole: z.string().min(1).optional(),
    }).default({}),
  }).default({}),
});

async function readOptionalJsonFile(filePath: string): Promise<unknown | null> {
  try {
    await access(filePath, fsConstants.F_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const raw = await readFile(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Settings file contains invalid JSON: ${filePath}`);
  }
}

function parsePolicyFromConfig(config: unknown, filePath: string): AuthPolicy | null {
  if (!config || typeof config !== "object") {
    return null;
  }

  const candidate = (config as { authorization?: { policy?: unknown } }).authorization?.policy;
  if (candidate === undefined) {
    return null;
  }

  const parsed = PolicyContainerSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid authorization policy in ${filePath}: ${issues}`);
  }

  return parsed.data.authorization.policy;
}

export async function loadAuthPolicy(settingsFilePath: string): Promise<AuthPolicy> {
  const globalSettingsFilePath = resolveGlobalSettingsFilePath();
  const globalConfig = settingsFilePath === globalSettingsFilePath
    ? null
    : await readOptionalJsonFile(globalSettingsFilePath);
  const localConfig = await readOptionalJsonFile(settingsFilePath);

  const globalPolicy = globalConfig
    ? parsePolicyFromConfig(globalConfig, globalSettingsFilePath)
    : null;
  const localPolicy = localConfig
    ? parsePolicyFromConfig(localConfig, settingsFilePath)
    : null;

  return localPolicy ?? globalPolicy ?? DEFAULT_AUTH_POLICY;
}

function parseRoleConfigFromConfig(config: unknown): RoleResolutionConfig | null {
  if (!config || typeof config !== "object") {
    return null;
  }

  const parsed = RoleConfigContainerSchema.safeParse(config);
  if (!parsed.success) {
    return null;
  }

  return {
    telegramOwnerId: parsed.data.telegram?.ownerId,
    telegramRoles: (parsed.data.authorization as any)?.roles?.telegramRoles ?? [],
    cliRole: (parsed.data.authorization as any)?.roles?.cliRole,
  };
}

export async function loadRoleResolutionConfig(settingsFilePath: string): Promise<RoleResolutionConfig> {
  const globalSettingsFilePath = resolveGlobalSettingsFilePath();
  const globalConfig = settingsFilePath === globalSettingsFilePath
    ? null
    : await readOptionalJsonFile(globalSettingsFilePath);
  const localConfig = await readOptionalJsonFile(settingsFilePath);

  const globalRoleConfig = globalConfig ? parseRoleConfigFromConfig(globalConfig) : null;
  const localRoleConfig = localConfig ? parseRoleConfigFromConfig(localConfig) : null;

  return {
    telegramOwnerId: localRoleConfig?.telegramOwnerId ?? globalRoleConfig?.telegramOwnerId,
    telegramRoles: localRoleConfig?.telegramRoles ?? globalRoleConfig?.telegramRoles ?? [],
    cliRole: localRoleConfig?.cliRole ?? globalRoleConfig?.cliRole,
  };
}

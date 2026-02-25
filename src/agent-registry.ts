import { dirname, resolve } from "node:path";

import { resolveGlobalSettingsFilePath } from "./cli/settings";

export const DEFAULT_AGENT_REGISTRY_FILE = "agents.json";

export function resolveAgentRegistryFilePath(_cwd: string): string {
  const globalSettingsFilePath = resolveGlobalSettingsFilePath();
  return resolve(dirname(globalSettingsFilePath), DEFAULT_AGENT_REGISTRY_FILE);
}

import { resolve } from "node:path";

export const DEFAULT_AGENT_REGISTRY_RELATIVE_PATH = ".ixado/agents.json";

export function resolveAgentRegistryFilePath(cwd: string): string {
  return resolve(cwd, DEFAULT_AGENT_REGISTRY_RELATIVE_PATH);
}

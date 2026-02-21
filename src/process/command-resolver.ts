import { existsSync } from "node:fs";
import { extname, join } from "node:path";

const DEFAULT_WINDOWS_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD", ".PS1"];

type ExistsFn = (path: string) => boolean;

export function resolveCommandForSpawn(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: ExistsFn = existsSync
): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return command;
  }

  if (platform !== "win32") {
    return trimmed;
  }

  if (trimmed.includes("/") || trimmed.includes("\\") || extname(trimmed)) {
    return trimmed;
  }

  const pathValue = env.Path ?? env.PATH;
  if (!pathValue) {
    return trimmed;
  }

  const pathext = (env.PATHEXT ?? DEFAULT_WINDOWS_PATHEXT.join(";"))
    .split(";")
    .map((ext) => ext.trim().toUpperCase())
    .filter((ext) => ext.length > 0)
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));

  const paths = pathValue.split(";").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  for (const dir of paths) {
    for (const ext of pathext) {
      const candidate = join(dir, `${trimmed}${ext}`);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }

  return trimmed;
}

import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface TesterConfig {
  command: string;
  args: string[];
}

function readFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function isUvProject(dir: string): boolean {
  if (existsSync(join(dir, "uv.lock"))) return true;
  const pyproject = readFile(join(dir, "pyproject.toml"));
  if (!pyproject) return false;
  return (
    pyproject.includes("[tool.uv]") ||
    (pyproject.includes("requires-python") &&
      !pyproject.includes("[tool.poetry]"))
  );
}

function isPoetryProject(dir: string): boolean {
  const pyproject = readFile(join(dir, "pyproject.toml"));
  return !!pyproject?.includes("[tool.poetry]");
}

function hasPytest(dir: string): boolean {
  const pyproject = readFile(join(dir, "pyproject.toml"));
  if (pyproject?.includes("pytest")) return true;
  if (existsSync(join(dir, "pytest.ini"))) return true;
  const setupCfg = readFile(join(dir, "setup.cfg"));
  if (setupCfg?.includes("[tool:pytest]")) return true;
  return false;
}

function detectJsTester(dir: string): TesterConfig | null {
  const raw = readFile(join(dir, "package.json"));
  if (!raw) return null;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }
  const scripts = pkg.scripts as Record<string, string> | undefined;
  if (scripts?.test && !scripts.test.includes("no test specified")) {
    const usesBun =
      existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"));
    return usesBun
      ? { command: "bun", args: ["run", "test"] }
      : { command: "npm", args: ["test"] };
  }
  const allDeps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
  if (allDeps.vitest) return { command: "npx", args: ["vitest", "run"] };
  if (allDeps.jest) return { command: "npx", args: ["jest"] };
  return null;
}

/**
 * Detects the appropriate test command for a project by inspecting its files.
 * Checks the project root first, then common subdirectories (backend/, src/).
 * Returns null if no test framework can be identified.
 */
export function detectTester(projectRootDir: string): TesterConfig | null {
  // Root-level Python
  if (hasPytest(projectRootDir)) {
    if (isUvProject(projectRootDir)) {
      return { command: "uv", args: ["run", "pytest"] };
    }
    if (isPoetryProject(projectRootDir)) {
      return { command: "poetry", args: ["run", "pytest"] };
    }
  }

  // backend/ subdirectory (full-stack projects)
  for (const subdir of ["backend", "src"]) {
    const dir = join(projectRootDir, subdir);
    if (!existsSync(dir)) continue;
    if (hasPytest(dir)) {
      if (isUvProject(dir)) {
        return {
          command: "uv",
          args: ["run", "--directory", subdir, "pytest"],
        };
      }
      if (isPoetryProject(dir)) {
        return {
          command: "bash",
          args: ["-c", `cd ${subdir} && poetry run pytest`],
        };
      }
    }
  }

  // Root-level JS/TS
  const jsTester = detectJsTester(projectRootDir);
  if (jsTester) return jsTester;

  // Rust
  if (existsSync(join(projectRootDir, "Cargo.toml"))) {
    return { command: "cargo", args: ["test"] };
  }

  // Go
  if (existsSync(join(projectRootDir, "go.mod"))) {
    return { command: "go", args: ["test", "./..."] };
  }

  // Makefile with test target
  const makefile = readFile(join(projectRootDir, "Makefile"));
  if (makefile && /^test\s*:/m.test(makefile)) {
    return { command: "make", args: ["test"] };
  }

  return null;
}

/**
 * Resolves the final tester config using a three-level priority chain:
 * 1. Per-project override (undefined = not set, null = explicitly disabled)
 * 2. Global config
 * 3. Auto-detection from project files
 */
export function resolveTesterConfig(input: {
  projectTesterCommand: string | null | undefined;
  projectTesterArgs: string[] | null | undefined;
  projectTesterTimeoutMs: number | undefined;
  globalTesterCommand: string | null;
  globalTesterArgs: string[] | null;
  globalTesterTimeoutMs: number;
  projectRootDir: string;
}): {
  testerCommand: string | null;
  testerArgs: string[] | null;
  testerTimeoutMs: number;
} {
  const timeoutMs = input.projectTesterTimeoutMs ?? input.globalTesterTimeoutMs;

  // Project-level explicit override (null = disable tester for this project)
  if (input.projectTesterCommand !== undefined) {
    return {
      testerCommand: input.projectTesterCommand,
      testerArgs:
        input.projectTesterArgs !== undefined
          ? input.projectTesterArgs
          : input.globalTesterArgs,
      testerTimeoutMs: timeoutMs,
    };
  }

  // Global config has an explicit command
  if (input.globalTesterCommand !== null) {
    return {
      testerCommand: input.globalTesterCommand,
      testerArgs: input.globalTesterArgs,
      testerTimeoutMs: timeoutMs,
    };
  }

  // Auto-detect from project files
  const detected = detectTester(input.projectRootDir);
  return {
    testerCommand: detected?.command ?? null,
    testerArgs: detected?.args ?? null,
    testerTimeoutMs: timeoutMs,
  };
}

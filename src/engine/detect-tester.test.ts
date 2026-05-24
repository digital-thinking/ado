import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { detectTester, resolveTesterConfig } from "./detect-tester";

function tmpDir(): string {
  const dir = join(import.meta.dir, `__tmp_detect_tester_${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("detectTester", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for empty project", () => {
    expect(detectTester(dir)).toBeNull();
  });

  it("detects uv project at root via uv.lock", () => {
    writeFileSync(join(dir, "uv.lock"), "");
    writeFileSync(join(dir, "pytest.ini"), "");
    const result = detectTester(dir);
    expect(result).toEqual({ command: "uv", args: ["run", "pytest"] });
  });

  it("detects uv project at root via pyproject.toml with requires-python", () => {
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[project]\nrequires-python = ">=3.12"\n\n[dependency-groups]\ndev = ["pytest>=8.0"]\n',
    );
    expect(detectTester(dir)).toEqual({
      command: "uv",
      args: ["run", "pytest"],
    });
  });

  it("detects poetry project at root", () => {
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[tool.poetry]\nname = "myapp"\n\n[tool.poetry.dev-dependencies]\npytest = "^8.0"\n',
    );
    expect(detectTester(dir)).toEqual({
      command: "poetry",
      args: ["run", "pytest"],
    });
  });

  it("detects uv in backend/ subdirectory", () => {
    const backendDir = join(dir, "backend");
    mkdirSync(backendDir);
    writeFileSync(join(backendDir, "uv.lock"), "");
    writeFileSync(join(backendDir, "pytest.ini"), "");
    expect(detectTester(dir)).toEqual({
      command: "uv",
      args: ["run", "--directory", "backend", "pytest"],
    });
  });

  it("detects poetry in backend/ subdirectory", () => {
    const backendDir = join(dir, "backend");
    mkdirSync(backendDir);
    writeFileSync(
      join(backendDir, "pyproject.toml"),
      '[tool.poetry]\nname = "backend"\n\n[tool.poetry.dev-dependencies]\npytest = "^8.0"\n',
    );
    expect(detectTester(dir)).toEqual({
      command: "bash",
      args: ["-c", "cd backend && poetry run pytest"],
    });
  });

  it("detects npm test from package.json scripts", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    expect(detectTester(dir)).toEqual({ command: "npm", args: ["test"] });
  });

  it("ignores default npm placeholder test script", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
    );
    expect(detectTester(dir)).toBeNull();
  });

  it("detects vitest from devDependencies when no test script", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^2.0.0" } }),
    );
    expect(detectTester(dir)).toEqual({
      command: "npx",
      args: ["vitest", "run"],
    });
  });

  it("detects jest from devDependencies", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ devDependencies: { jest: "^29.0.0" } }),
    );
    expect(detectTester(dir)).toEqual({ command: "npx", args: ["jest"] });
  });

  it("detects cargo test", () => {
    writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "myapp"\n');
    expect(detectTester(dir)).toEqual({ command: "cargo", args: ["test"] });
  });

  it("detects go test", () => {
    writeFileSync(join(dir, "go.mod"), "module example.com/myapp\n");
    expect(detectTester(dir)).toEqual({
      command: "go",
      args: ["test", "./..."],
    });
  });

  it("detects make test from Makefile", () => {
    writeFileSync(
      join(dir, "Makefile"),
      "build:\n\tgo build\n\ntest:\n\tgo test ./...\n",
    );
    expect(detectTester(dir)).toEqual({ command: "make", args: ["test"] });
  });

  it("prefers root Python over backend JS", () => {
    writeFileSync(join(dir, "uv.lock"), "");
    writeFileSync(join(dir, "pytest.ini"), "");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ devDependencies: { jest: "^29.0.0" } }),
    );
    expect(detectTester(dir)).toEqual({
      command: "uv",
      args: ["run", "pytest"],
    });
  });
});

describe("resolveTesterConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const base = {
    globalTesterCommand: "poetry" as string | null,
    globalTesterArgs: ["run", "pytest"] as string[] | null,
    globalTesterTimeoutMs: 60000,
  };

  it("uses project override when set", () => {
    const result = resolveTesterConfig({
      ...base,
      projectTesterCommand: "uv",
      projectTesterArgs: ["run", "pytest"],
      projectTesterTimeoutMs: undefined,
      projectRootDir: dir,
    });
    expect(result.testerCommand).toBe("uv");
    expect(result.testerArgs).toEqual(["run", "pytest"]);
  });

  it("project null disables tester even if global is set", () => {
    const result = resolveTesterConfig({
      ...base,
      projectTesterCommand: null,
      projectTesterArgs: undefined,
      projectTesterTimeoutMs: undefined,
      projectRootDir: dir,
    });
    expect(result.testerCommand).toBeNull();
  });

  it("falls through to global when project override is undefined", () => {
    const result = resolveTesterConfig({
      ...base,
      projectTesterCommand: undefined,
      projectTesterArgs: undefined,
      projectTesterTimeoutMs: undefined,
      projectRootDir: dir,
    });
    expect(result.testerCommand).toBe("poetry");
    expect(result.testerArgs).toEqual(["run", "pytest"]);
  });

  it("auto-detects when global is null and project is undefined", () => {
    writeFileSync(join(dir, "uv.lock"), "");
    writeFileSync(join(dir, "pytest.ini"), "");
    const result = resolveTesterConfig({
      ...base,
      globalTesterCommand: null,
      globalTesterArgs: null,
      projectTesterCommand: undefined,
      projectTesterArgs: undefined,
      projectTesterTimeoutMs: undefined,
      projectRootDir: dir,
    });
    expect(result.testerCommand).toBe("uv");
    expect(result.testerArgs).toEqual(["run", "pytest"]);
  });

  it("returns null tester when nothing is configured and no project files match", () => {
    const result = resolveTesterConfig({
      ...base,
      globalTesterCommand: null,
      globalTesterArgs: null,
      projectTesterCommand: undefined,
      projectTesterArgs: undefined,
      projectTesterTimeoutMs: undefined,
      projectRootDir: dir,
    });
    expect(result.testerCommand).toBeNull();
    expect(result.testerArgs).toBeNull();
  });

  it("uses project testerTimeoutMs over global", () => {
    const result = resolveTesterConfig({
      ...base,
      projectTesterCommand: "uv",
      projectTesterArgs: ["run", "pytest"],
      projectTesterTimeoutMs: 120000,
      projectRootDir: dir,
    });
    expect(result.testerTimeoutMs).toBe(120000);
  });

  it("falls back to global testerTimeoutMs when project does not override", () => {
    const result = resolveTesterConfig({
      ...base,
      projectTesterCommand: undefined,
      projectTesterArgs: undefined,
      projectTesterTimeoutMs: undefined,
      projectRootDir: dir,
    });
    expect(result.testerTimeoutMs).toBe(60000);
  });
});

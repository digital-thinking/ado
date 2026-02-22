import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";

const mode = process.argv[2]?.trim();
if (mode !== "unit" && mode !== "integration") {
  throw new Error("Usage: node scripts/run-tests.mjs <unit|integration>");
}

const rootDir = process.cwd();
const srcDir = join(rootDir, "src");

async function listTestFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTestFiles(fullPath)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.endsWith(".test.ts")) {
      continue;
    }

    const normalized = relative(rootDir, fullPath).split(sep).join("/");
    files.push(normalized);
  }

  return files;
}

function isIntegrationTest(filePath) {
  return filePath.endsWith(".integration.test.ts");
}

const allTestFiles = (await listTestFiles(srcDir)).sort((a, b) => a.localeCompare(b));
const selectedFiles =
  mode === "integration"
    ? allTestFiles.filter(isIntegrationTest)
    : allTestFiles.filter((filePath) => !isIntegrationTest(filePath));

if (selectedFiles.length === 0) {
  console.info(`No ${mode} tests found.`);
  process.exit(0);
}

const bunCommand = process.platform === "win32" ? "bun.exe" : "bun";
const result = spawnSync(bunCommand, ["test", ...selectedFiles], {
  stdio: "inherit",
  cwd: rootDir,
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

if (result.error) {
  throw result.error;
}

process.exit(1);

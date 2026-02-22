import { readFile } from "node:fs/promises";

const lcovFilePath = process.argv[2]?.trim() || "coverage/lcov.info";

function parseCount(line, prefix) {
  return Number(line.slice(prefix.length).trim());
}

function formatPercent(hit, found) {
  if (found <= 0) {
    return "n/a";
  }

  return `${((hit / found) * 100).toFixed(2)}%`;
}

const raw = await readFile(lcovFilePath, "utf8");
const lines = raw.split(/\r?\n/);

let fileCount = 0;
let linesFound = 0;
let linesHit = 0;
let functionsFound = 0;
let functionsHit = 0;
let branchesFound = 0;
let branchesHit = 0;

for (const line of lines) {
  if (line.startsWith("SF:")) {
    fileCount += 1;
    continue;
  }
  if (line.startsWith("LF:")) {
    linesFound += parseCount(line, "LF:");
    continue;
  }
  if (line.startsWith("LH:")) {
    linesHit += parseCount(line, "LH:");
    continue;
  }
  if (line.startsWith("FNF:")) {
    functionsFound += parseCount(line, "FNF:");
    continue;
  }
  if (line.startsWith("FNH:")) {
    functionsHit += parseCount(line, "FNH:");
    continue;
  }
  if (line.startsWith("BRF:")) {
    branchesFound += parseCount(line, "BRF:");
    continue;
  }
  if (line.startsWith("BRH:")) {
    branchesHit += parseCount(line, "BRH:");
  }
}

const summaryLines = [
  "## Coverage Summary",
  "",
  `- Files: ${fileCount}`,
  `- Lines: ${formatPercent(linesHit, linesFound)} (${linesHit}/${linesFound})`,
  `- Functions: ${formatPercent(functionsHit, functionsFound)} (${functionsHit}/${functionsFound})`,
  `- Branches: ${formatPercent(branchesHit, branchesFound)} (${branchesHit}/${branchesFound})`,
];

console.info(summaryLines.join("\n"));

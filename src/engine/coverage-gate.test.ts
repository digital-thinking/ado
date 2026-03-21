import { describe, test, expect } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CoverageGate } from "./coverage-gate";
import type { GateContext } from "./gate";

const testDir = join(import.meta.dir, "__coverage_gate_test__");
const baseContext: GateContext = {
  phaseId: "phase-1",
  phaseName: "Test Phase",
  phase: {
    id: "phase-1",
    name: "Test Phase",
    status: "CODING",
    branchName: "test-branch",
    tasks: [],
  } as any,
  cwd: testDir,
  baseBranch: "main",
  headBranch: "test-branch",
  vcsProviderType: "github",
};

function setup() {
  mkdirSync(testDir, { recursive: true });
}
function teardown() {
  rmSync(testDir, { recursive: true, force: true });
}

describe("CoverageGate", () => {
  test("lcov: passes when coverage meets threshold", async () => {
    setup();
    try {
      const lcov = `SF:src/main.ts\nLF:100\nLH:85\nend_of_record\n`;
      writeFileSync(join(testDir, "lcov.info"), lcov);

      const gate = new CoverageGate({
        reportPath: "lcov.info",
        minPct: 80,
      });
      const result = await gate.evaluate(baseContext);

      expect(result.passed).toBe(true);
      expect(result.diagnostics).toContain("85.0%");
      expect(result.diagnostics).toContain(">= 80%");
    } finally {
      teardown();
    }
  });

  test("lcov: fails when coverage below threshold", async () => {
    setup();
    try {
      const lcov = `SF:src/main.ts\nLF:100\nLH:50\nend_of_record\n`;
      writeFileSync(join(testDir, "lcov.info"), lcov);

      const gate = new CoverageGate({
        reportPath: "lcov.info",
        minPct: 80,
      });
      const result = await gate.evaluate(baseContext);

      expect(result.passed).toBe(false);
      expect(result.diagnostics).toContain("50.0%");
      expect(result.diagnostics).toContain("< 80%");
    } finally {
      teardown();
    }
  });

  test("lcov: aggregates multiple records", async () => {
    setup();
    try {
      const lcov = [
        "SF:a.ts\nLF:50\nLH:40\nend_of_record",
        "SF:b.ts\nLF:50\nLH:45\nend_of_record",
      ].join("\n");
      writeFileSync(join(testDir, "lcov.info"), lcov);

      const gate = new CoverageGate({
        reportPath: "lcov.info",
        minPct: 80,
      });
      const result = await gate.evaluate(baseContext);

      // 85/100 = 85%
      expect(result.passed).toBe(true);
      expect(result.diagnostics).toContain("85.0%");
    } finally {
      teardown();
    }
  });

  test("json: parses istanbul/nyc format", async () => {
    setup();
    try {
      const json = JSON.stringify({ total: { lines: { pct: 92.3 } } });
      writeFileSync(join(testDir, "coverage.json"), json);

      const gate = new CoverageGate({
        reportPath: "coverage.json",
        minPct: 90,
      });
      const result = await gate.evaluate(baseContext);

      expect(result.passed).toBe(true);
      expect(result.diagnostics).toContain("92.3%");
    } finally {
      teardown();
    }
  });

  test("json: parses statements.pct fallback", async () => {
    setup();
    try {
      const json = JSON.stringify({ total: { statements: { pct: 75 } } });
      writeFileSync(join(testDir, "coverage.json"), json);

      const gate = new CoverageGate({
        reportPath: "coverage.json",
        minPct: 80,
        format: "json",
      });
      const result = await gate.evaluate(baseContext);

      expect(result.passed).toBe(false);
      expect(result.diagnostics).toContain("75.0%");
    } finally {
      teardown();
    }
  });

  test("cobertura: parses line-rate attribute", async () => {
    setup();
    try {
      const xml = `<?xml version="1.0"?>\n<coverage line-rate="0.88" branch-rate="0.75">\n</coverage>`;
      writeFileSync(join(testDir, "coverage.xml"), xml);

      const gate = new CoverageGate({
        reportPath: "coverage.xml",
        minPct: 85,
      });
      const result = await gate.evaluate(baseContext);

      expect(result.passed).toBe(true);
      expect(result.diagnostics).toContain("88.0%");
    } finally {
      teardown();
    }
  });

  test("returns retryable when report file missing", async () => {
    const gate = new CoverageGate({
      reportPath: "/nonexistent/coverage.json",
      minPct: 80,
    });
    const result = await gate.evaluate(baseContext);

    expect(result.passed).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.diagnostics).toContain("Coverage report not found");
  });

  test("returns non-retryable on parse failure", async () => {
    setup();
    try {
      writeFileSync(join(testDir, "bad.json"), "not json at all");

      const gate = new CoverageGate({
        reportPath: "bad.json",
        minPct: 80,
        format: "json",
      });
      const result = await gate.evaluate(baseContext);

      expect(result.passed).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.diagnostics).toContain("Failed to parse");
    } finally {
      teardown();
    }
  });

  test("auto-detects format from content", async () => {
    setup();
    try {
      // JSON content should be auto-detected
      const json = JSON.stringify({ total: { lines: { pct: 95 } } });
      writeFileSync(join(testDir, "report.txt"), json);

      const gate = new CoverageGate({
        reportPath: "report.txt",
        minPct: 90,
      });
      const result = await gate.evaluate(baseContext);

      expect(result.passed).toBe(true);
    } finally {
      teardown();
    }
  });
});

import { readFileSync } from "node:fs";
import { type Gate, type GateContext, type GateResult } from "./gate";

export type CoverageGateConfig = {
  /** Path to coverage report file (absolute or relative to cwd). */
  reportPath: string;
  /** Minimum coverage percentage required to pass (0-100). */
  minPct: number;
  /**
   * Report format. Auto-detected from content if omitted.
   * - "lcov": LCOV tracefile
   * - "json": JSON with a top-level `total.lines.pct` or `total.statements.pct`
   * - "cobertura": Cobertura XML with `line-rate` attribute
   */
  format?: "lcov" | "json" | "cobertura";
};

/**
 * A gate that parses a coverage report and enforces a minimum threshold.
 */
export class CoverageGate implements Gate {
  readonly name = "coverage";
  private readonly config: CoverageGateConfig;

  constructor(config: CoverageGateConfig) {
    this.config = config;
  }

  async evaluate(context: GateContext): Promise<GateResult> {
    const reportPath = this.config.reportPath.startsWith("/")
      ? this.config.reportPath
      : `${context.cwd}/${this.config.reportPath}`;

    let content: string;
    try {
      content = readFileSync(reportPath, "utf-8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        gate: this.name,
        passed: false,
        diagnostics: `Coverage report not found: ${message}`,
        retryable: true,
      };
    }

    try {
      const pct = this.parseCoverage(content);
      const passed = pct >= this.config.minPct;
      return {
        gate: this.name,
        passed,
        diagnostics: passed
          ? `Coverage ${pct.toFixed(1)}% >= ${this.config.minPct}% threshold.`
          : `Coverage ${pct.toFixed(1)}% < ${this.config.minPct}% threshold.`,
        retryable: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        gate: this.name,
        passed: false,
        diagnostics: `Failed to parse coverage report: ${message}`,
        retryable: false,
      };
    }
  }

  private parseCoverage(content: string): number {
    const format = this.config.format ?? this.detectFormat(content);
    switch (format) {
      case "lcov":
        return this.parseLcov(content);
      case "json":
        return this.parseJson(content);
      case "cobertura":
        return this.parseCobertura(content);
      default: {
        const _exhaustive: never = format;
        throw new Error(`Unknown coverage format: ${_exhaustive}`);
      }
    }
  }

  private detectFormat(content: string): "lcov" | "json" | "cobertura" {
    const trimmed = content.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
    if (trimmed.startsWith("<?xml") || trimmed.startsWith("<coverage"))
      return "cobertura";
    return "lcov";
  }

  private parseLcov(content: string): number {
    let linesFound = 0;
    let linesHit = 0;
    for (const line of content.split("\n")) {
      if (line.startsWith("LF:")) {
        linesFound += parseInt(line.slice(3), 10) || 0;
      } else if (line.startsWith("LH:")) {
        linesHit += parseInt(line.slice(3), 10) || 0;
      }
    }
    if (linesFound === 0) {
      throw new Error("LCOV report has no line data (LF/LH records).");
    }
    return (linesHit / linesFound) * 100;
  }

  private parseJson(content: string): number {
    const data = JSON.parse(content);
    // istanbul / nyc / c8 format: { total: { lines: { pct: N } } }
    if (data?.total?.lines?.pct !== undefined) {
      return Number(data.total.lines.pct);
    }
    if (data?.total?.statements?.pct !== undefined) {
      return Number(data.total.statements.pct);
    }
    throw new Error(
      "JSON coverage report missing total.lines.pct or total.statements.pct.",
    );
  }

  private parseCobertura(content: string): number {
    // Extract line-rate from <coverage line-rate="0.85" ...>
    const match = content.match(/line-rate="([^"]+)"/);
    if (!match) {
      throw new Error("Cobertura XML missing line-rate attribute.");
    }
    return parseFloat(match[1]) * 100;
  }
}

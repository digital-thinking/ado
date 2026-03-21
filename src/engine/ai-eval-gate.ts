import { type Gate, type GateContext, type GateResult } from "./gate";
import type { ProcessRunner } from "../process";

export type AiEvalGateConfig = {
  /** CLI command for the adapter (e.g. "codex" or "claude"). */
  command: string;
  /** Arguments for the adapter (e.g. ["--model", "gpt-4"]). */
  args?: string[];
  /** User-defined rubric appended to the evaluation prompt. */
  rubric: string;
  /** Keywords that indicate a pass verdict (case-insensitive). Defaults to ["PASS", "APPROVED"]. */
  passKeywords?: string[];
  /** Keywords that indicate a fail verdict (case-insensitive). Defaults to ["FAIL", "REJECTED"]. */
  failKeywords?: string[];
  /** Maximum retries on fail verdict before giving up. Defaults to 0. */
  maxRetries?: number;
  /** Timeout per evaluation call in ms. Defaults to 120_000 (2 minutes). */
  timeoutMs?: number;
};

const DEFAULT_PASS_KEYWORDS = ["PASS", "APPROVED"];
const DEFAULT_FAIL_KEYWORDS = ["FAIL", "REJECTED"];
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * A gate that sends git diff + rubric to an AI adapter and scans the
 * response for pass/fail keywords.
 */
export class AiEvalGate implements Gate {
  readonly name = "ai_eval";
  private readonly config: AiEvalGateConfig;
  private readonly runner: ProcessRunner;
  private readonly diffRunner: ProcessRunner;

  constructor(
    config: AiEvalGateConfig,
    runner: ProcessRunner,
    diffRunner?: ProcessRunner,
  ) {
    this.config = config;
    this.runner = runner;
    this.diffRunner = diffRunner ?? runner;
  }

  async evaluate(context: GateContext): Promise<GateResult> {
    let diff: string;
    try {
      const diffResult = await this.diffRunner.run({
        command: "git",
        args: ["diff", `${context.baseBranch}...${context.headBranch}`],
        cwd: context.cwd,
        timeoutMs: 30_000,
        approvedCommandBuilder: true,
      });
      diff = diffResult.stdout.trim();
      if (!diff) {
        return {
          gate: this.name,
          passed: true,
          diagnostics: "No diff to evaluate.",
          retryable: false,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        gate: this.name,
        passed: false,
        diagnostics: `Failed to get diff: ${message}`,
        retryable: true,
      };
    }

    const maxRetries = this.config.maxRetries ?? 0;
    const passKeywords = (
      this.config.passKeywords ?? DEFAULT_PASS_KEYWORDS
    ).map((k) => k.toUpperCase());
    const failKeywords = (
      this.config.failKeywords ?? DEFAULT_FAIL_KEYWORDS
    ).map((k) => k.toUpperCase());

    const prompt = buildEvalPrompt(diff, this.config.rubric);

    let lastResponse = "";
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.runner.run({
          command: this.config.command,
          args: this.config.args ?? [],
          cwd: context.cwd,
          stdin: prompt,
          timeoutMs: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          approvedCommandBuilder: true,
        });

        lastResponse = [result.stdout.trim(), result.stderr.trim()]
          .filter((s) => s.length > 0)
          .join("\n");
        const upper = lastResponse.toUpperCase();

        if (passKeywords.some((kw) => upper.includes(kw))) {
          return {
            gate: this.name,
            passed: true,
            diagnostics: lastResponse,
            retryable: false,
          };
        }

        if (failKeywords.some((kw) => upper.includes(kw))) {
          if (attempt < maxRetries) {
            continue;
          }
          return {
            gate: this.name,
            passed: false,
            diagnostics: lastResponse,
            retryable: false,
          };
        }

        // No keyword matched — treat as inconclusive fail
        return {
          gate: this.name,
          passed: false,
          diagnostics: `No pass/fail keyword detected in response:\n${lastResponse}`,
          retryable: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          gate: this.name,
          passed: false,
          diagnostics: `AI eval failed: ${message}`,
          retryable: true,
        };
      }
    }

    return {
      gate: this.name,
      passed: false,
      diagnostics: `AI eval failed after ${maxRetries + 1} attempts:\n${lastResponse}`,
      retryable: false,
    };
  }
}

function buildEvalPrompt(diff: string, rubric: string): string {
  return [
    "You are a code reviewer evaluating a diff against a rubric.",
    "Respond with PASS if the changes meet the rubric, or FAIL with an explanation if they do not.",
    "",
    "## Rubric",
    rubric,
    "",
    "## Diff",
    "```diff",
    diff.length > 50_000 ? diff.slice(0, 50_000) + "\n... (truncated)" : diff,
    "```",
  ].join("\n");
}

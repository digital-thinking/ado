import { type Gate, type GateContext, type GateResult } from "./gate";
import type { VcsProvider } from "../vcs/vcs-provider";
import type { CiPollTransition } from "../vcs/github-manager";

export type PrCiGateConfig = {
  /** Poll interval in ms. Defaults to 15_000 (15 seconds). */
  intervalMs?: number;
  /** Overall poll timeout in ms. Defaults to 900_000 (15 minutes). */
  timeoutMs?: number;
  /** Number of consecutive terminal observations before accepting result. Defaults to 2. */
  terminalConfirmations?: number;
  /** Callback for CI poll transitions (for logging/events). */
  onTransition?: (transition: CiPollTransition) => void | Promise<void>;
};

/**
 * A gate that polls CI check status for a PR via the VcsProvider.
 * Passes if all checks succeed; fails if any check fails.
 * Requires `prNumber` in the GateContext.
 */
export class PrCiGate implements Gate {
  readonly name = "pr_ci";
  private readonly config: PrCiGateConfig;
  private readonly vcsProvider: VcsProvider;

  constructor(config: PrCiGateConfig, vcsProvider: VcsProvider) {
    this.config = config;
    this.vcsProvider = vcsProvider;
  }

  async evaluate(context: GateContext): Promise<GateResult> {
    if (!context.prNumber) {
      return {
        gate: this.name,
        passed: false,
        diagnostics: "PR CI gate requires a PR number in context.",
        retryable: false,
      };
    }

    try {
      const summary = await this.vcsProvider.pollChecks({
        prNumber: context.prNumber,
        cwd: context.cwd,
        intervalMs: this.config.intervalMs ?? 15_000,
        timeoutMs: this.config.timeoutMs ?? 900_000,
        terminalConfirmations: this.config.terminalConfirmations ?? 2,
        onTransition: this.config.onTransition,
      });

      const checkLines = summary.checks
        .map((c) => {
          const url = c.detailsUrl ? ` -> ${c.detailsUrl}` : "";
          return `- ${c.name} [${c.state}]${url}`;
        })
        .join("\n");

      if (summary.overall === "SUCCESS") {
        return {
          gate: this.name,
          passed: true,
          diagnostics: `All CI checks passed.\n${checkLines}`,
          retryable: false,
        };
      }

      return {
        gate: this.name,
        passed: false,
        diagnostics: `CI checks ${summary.overall}.\n${checkLines}`,
        retryable: summary.overall === "PENDING",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        gate: this.name,
        passed: false,
        diagnostics: `CI polling failed: ${message}`,
        retryable: true,
      };
    }
  }
}

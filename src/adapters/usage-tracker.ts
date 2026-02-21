import type { ProcessRunner } from "../process";

export const DEFAULT_CODEXBAR_POLL_INTERVAL_MS = 5 * 60 * 1000;

export type CodexUsageSnapshot = {
  capturedAt: string;
  payload: unknown;
  raw: string;
};

type CodexUsageTrackerOptions = {
  pollIntervalMs?: number;
  maxSnapshots?: number;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class CodexUsageTracker {
  private readonly runner: ProcessRunner;
  private readonly pollIntervalMs: number;
  private readonly maxSnapshots: number;
  private readonly snapshots: CodexUsageSnapshot[] = [];

  constructor(runner: ProcessRunner, options: CodexUsageTrackerOptions = {}) {
    this.runner = runner;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_CODEXBAR_POLL_INTERVAL_MS;
    this.maxSnapshots = options.maxSnapshots ?? 100;
  }

  getSnapshots(): CodexUsageSnapshot[] {
    return [...this.snapshots];
  }

  async collect(cwd: string): Promise<CodexUsageSnapshot> {
    if (!cwd.trim()) {
      throw new Error("cwd must not be empty.");
    }

    const result = await this.runner.run({
      command: "codexbar",
      args: ["--source", "cli", "--provider", "all", "--json"],
      cwd,
    });

    let payload: unknown;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new Error("codexbar returned invalid JSON.");
    }

    const snapshot: CodexUsageSnapshot = {
      capturedAt: new Date().toISOString(),
      payload,
      raw: result.stdout,
    };

    this.snapshots.push(snapshot);
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.splice(0, this.snapshots.length - this.maxSnapshots);
    }

    return snapshot;
  }

  async poll(
    cwd: string,
    shouldContinue: () => boolean = () => true
  ): Promise<CodexUsageSnapshot[]> {
    if (!cwd.trim()) {
      throw new Error("cwd must not be empty.");
    }

    while (shouldContinue()) {
      await this.collect(cwd);
      await delay(this.pollIntervalMs);
    }

    return this.getSnapshots();
  }
}

import type { CodexUsageSnapshot } from "../adapters";

type UsageTrackerLike = {
  collect(cwd: string): Promise<CodexUsageSnapshot>;
};

export type UsageResponse = {
  available: boolean;
  message?: string;
  snapshot?: CodexUsageSnapshot;
};

export class UsageService {
  private readonly tracker: UsageTrackerLike;
  private readonly cwd: string;
  private readonly codexbarEnabled: boolean;

  constructor(tracker: UsageTrackerLike, cwd: string, options: { codexbarEnabled?: boolean } = {}) {
    this.tracker = tracker;
    this.cwd = cwd;
    this.codexbarEnabled = options.codexbarEnabled ?? true;
  }

  async getLatest(): Promise<UsageResponse> {
    if (!this.codexbarEnabled) {
      return {
        available: false,
        message: "codexbar usage telemetry is disabled by config.",
      };
    }

    try {
      const snapshot = await this.tracker.collect(this.cwd);
      return {
        available: true,
        snapshot,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        message,
      };
    }
  }
}

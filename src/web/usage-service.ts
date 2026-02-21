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

  constructor(tracker: UsageTrackerLike, cwd: string) {
    this.tracker = tracker;
    this.cwd = cwd;
  }

  async getLatest(): Promise<UsageResponse> {
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

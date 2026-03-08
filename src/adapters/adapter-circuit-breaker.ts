import type { CLIAdapterId } from "../types";

export type AdapterCircuitBreakerConfig = {
  failureThreshold: number;
  cooldownMs: number;
};

export type AdapterCircuitState = "CLOSED" | "OPEN";
export type AdapterCircuitTransition = "none" | "opened" | "closed";

export type AdapterCircuitSnapshot = {
  adapterId: CLIAdapterId;
  state: AdapterCircuitState;
  consecutiveFailures: number;
  failureThreshold: number;
  cooldownMs: number;
  openedAt: string | null;
  remainingCooldownMs: number;
};

export type AdapterCircuitDecision = {
  canExecute: boolean;
  transition: AdapterCircuitTransition;
  snapshot: AdapterCircuitSnapshot;
};

type AdapterCircuitRecord = {
  consecutiveFailures: number;
  openedAtMs: number | null;
};

type AdapterCircuitResolveResult = {
  record: AdapterCircuitRecord;
  transition: AdapterCircuitTransition;
};

function validateConfig(config: AdapterCircuitBreakerConfig): void {
  if (
    !Number.isInteger(config.failureThreshold) ||
    config.failureThreshold < 1
  ) {
    throw new Error(
      "failureThreshold must be an integer greater than or equal to 1.",
    );
  }
  if (!Number.isInteger(config.cooldownMs) || config.cooldownMs < 0) {
    throw new Error(
      "cooldownMs must be an integer greater than or equal to 0.",
    );
  }
}

export class AdapterCircuitBreaker {
  readonly failureThreshold: number;
  readonly cooldownMs: number;

  private readonly records = new Map<CLIAdapterId, AdapterCircuitRecord>();

  constructor(config: AdapterCircuitBreakerConfig) {
    validateConfig(config);
    this.failureThreshold = config.failureThreshold;
    this.cooldownMs = config.cooldownMs;
  }

  check(
    adapterId: CLIAdapterId,
    nowMs: number = Date.now(),
  ): AdapterCircuitDecision {
    const { transition } = this.resolveRecord(adapterId, nowMs);
    return this.buildDecision(adapterId, transition, nowMs);
  }

  recordSuccess(
    adapterId: CLIAdapterId,
    nowMs: number = Date.now(),
  ): AdapterCircuitDecision {
    const record = this.getOrCreateRecord(adapterId);
    const wasOpen = record.openedAtMs !== null;
    record.consecutiveFailures = 0;
    record.openedAtMs = null;
    return this.buildDecision(adapterId, wasOpen ? "closed" : "none", nowMs);
  }

  recordFailure(
    adapterId: CLIAdapterId,
    nowMs: number = Date.now(),
  ): AdapterCircuitDecision {
    const { record, transition: cooldownTransition } = this.resolveRecord(
      adapterId,
      nowMs,
    );

    if (record.openedAtMs !== null) {
      return this.buildDecision(adapterId, cooldownTransition, nowMs);
    }

    record.consecutiveFailures += 1;
    if (record.consecutiveFailures >= this.failureThreshold) {
      record.openedAtMs = nowMs;
      return this.buildDecision(adapterId, "opened", nowMs);
    }

    return this.buildDecision(adapterId, cooldownTransition, nowMs);
  }

  private resolveRecord(
    adapterId: CLIAdapterId,
    nowMs: number,
  ): AdapterCircuitResolveResult {
    const record = this.getOrCreateRecord(adapterId);
    if (record.openedAtMs === null) {
      return { record, transition: "none" };
    }

    const elapsedMs = nowMs - record.openedAtMs;
    if (elapsedMs < this.cooldownMs) {
      return { record, transition: "none" };
    }

    record.openedAtMs = null;
    record.consecutiveFailures = 0;
    return { record, transition: "closed" };
  }

  private buildDecision(
    adapterId: CLIAdapterId,
    transition: AdapterCircuitTransition,
    nowMs: number,
  ): AdapterCircuitDecision {
    const record = this.getOrCreateRecord(adapterId);
    const state: AdapterCircuitState =
      record.openedAtMs === null ? "CLOSED" : "OPEN";
    const remainingCooldownMs =
      record.openedAtMs === null
        ? 0
        : Math.max(0, this.cooldownMs - (nowMs - record.openedAtMs));

    return {
      canExecute: state === "CLOSED",
      transition,
      snapshot: {
        adapterId,
        state,
        consecutiveFailures: record.consecutiveFailures,
        failureThreshold: this.failureThreshold,
        cooldownMs: this.cooldownMs,
        openedAt:
          record.openedAtMs === null
            ? null
            : new Date(record.openedAtMs).toISOString(),
        remainingCooldownMs,
      },
    };
  }

  private getOrCreateRecord(adapterId: CLIAdapterId): AdapterCircuitRecord {
    const existing = this.records.get(adapterId);
    if (existing) {
      return existing;
    }
    const created: AdapterCircuitRecord = {
      consecutiveFailures: 0,
      openedAtMs: null,
    };
    this.records.set(adapterId, created);
    return created;
  }
}

const breakerSingletonByLifetime = new WeakMap<object, AdapterCircuitBreaker>();

export function getAdapterCircuitBreakerSingleton(input: {
  phaseRunnerLifetime: object;
  config: AdapterCircuitBreakerConfig;
}): AdapterCircuitBreaker {
  if (
    !input.phaseRunnerLifetime ||
    (typeof input.phaseRunnerLifetime !== "object" &&
      typeof input.phaseRunnerLifetime !== "function")
  ) {
    throw new Error("phaseRunnerLifetime must be an object.");
  }

  const existing = breakerSingletonByLifetime.get(input.phaseRunnerLifetime);
  if (!existing) {
    const created = new AdapterCircuitBreaker(input.config);
    breakerSingletonByLifetime.set(input.phaseRunnerLifetime, created);
    return created;
  }

  if (
    existing.failureThreshold !== input.config.failureThreshold ||
    existing.cooldownMs !== input.config.cooldownMs
  ) {
    throw new Error(
      "AdapterCircuitBreaker singleton already exists for this phase-runner lifetime with a different configuration.",
    );
  }

  return existing;
}

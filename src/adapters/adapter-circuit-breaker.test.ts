import { describe, expect, test } from "bun:test";

import {
  AdapterCircuitBreaker,
  getAdapterCircuitBreakerSingleton,
} from "./adapter-circuit-breaker";

describe("AdapterCircuitBreaker", () => {
  test("opens circuit after threshold consecutive failures", () => {
    const breaker = new AdapterCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 1_000,
    });

    const first = breaker.recordFailure("CODEX_CLI", 1_000);
    expect(first.canExecute).toBe(true);
    expect(first.transition).toBe("none");
    expect(first.snapshot.state).toBe("CLOSED");
    expect(first.snapshot.consecutiveFailures).toBe(1);

    const second = breaker.recordFailure("CODEX_CLI", 1_100);
    expect(second.canExecute).toBe(true);
    expect(second.snapshot.state).toBe("CLOSED");
    expect(second.snapshot.consecutiveFailures).toBe(2);

    const third = breaker.recordFailure("CODEX_CLI", 1_200);
    expect(third.canExecute).toBe(false);
    expect(third.transition).toBe("opened");
    expect(third.snapshot.state).toBe("OPEN");
    expect(third.snapshot.consecutiveFailures).toBe(3);
    expect(third.snapshot.remainingCooldownMs).toBe(1_000);
  });

  test("auto-closes open circuit after cooldown elapses", () => {
    const breaker = new AdapterCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 500,
    });
    breaker.recordFailure("CLAUDE_CLI", 2_000);

    const blocked = breaker.check("CLAUDE_CLI", 2_400);
    expect(blocked.canExecute).toBe(false);
    expect(blocked.snapshot.state).toBe("OPEN");
    expect(blocked.snapshot.remainingCooldownMs).toBe(100);
    expect(blocked.transition).toBe("none");

    const reopened = breaker.check("CLAUDE_CLI", 2_500);
    expect(reopened.canExecute).toBe(true);
    expect(reopened.transition).toBe("closed");
    expect(reopened.snapshot.state).toBe("CLOSED");
    expect(reopened.snapshot.consecutiveFailures).toBe(0);
    expect(reopened.snapshot.remainingCooldownMs).toBe(0);
  });

  test("success resets failure count and closes open circuit", () => {
    const breaker = new AdapterCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
    });
    breaker.recordFailure("GEMINI_CLI", 3_000);

    const success = breaker.recordSuccess("GEMINI_CLI", 3_100);
    expect(success.canExecute).toBe(true);
    expect(success.transition).toBe("closed");
    expect(success.snapshot.state).toBe("CLOSED");
    expect(success.snapshot.consecutiveFailures).toBe(0);
  });

  test("keeps open state stable when failures continue during cooldown", () => {
    const breaker = new AdapterCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1_000,
    });
    breaker.recordFailure("MOCK_CLI", 4_000);
    breaker.recordFailure("MOCK_CLI", 4_001);

    const continued = breaker.recordFailure("MOCK_CLI", 4_400);
    expect(continued.canExecute).toBe(false);
    expect(continued.transition).toBe("none");
    expect(continued.snapshot.state).toBe("OPEN");
    expect(continued.snapshot.consecutiveFailures).toBe(2);
  });

  test("validates configuration fail-fast", () => {
    expect(
      () =>
        new AdapterCircuitBreaker({
          failureThreshold: 0,
          cooldownMs: 1_000,
        }),
    ).toThrow(
      "failureThreshold must be an integer greater than or equal to 1.",
    );

    expect(
      () =>
        new AdapterCircuitBreaker({
          failureThreshold: 1,
          cooldownMs: -1,
        }),
    ).toThrow("cooldownMs must be an integer greater than or equal to 0.");
  });
});

describe("getAdapterCircuitBreakerSingleton", () => {
  test("reuses one breaker per phase-runner lifetime", () => {
    const lifetime = {};
    const first = getAdapterCircuitBreakerSingleton({
      phaseRunnerLifetime: lifetime,
      config: { failureThreshold: 2, cooldownMs: 60_000 },
    });
    const second = getAdapterCircuitBreakerSingleton({
      phaseRunnerLifetime: lifetime,
      config: { failureThreshold: 2, cooldownMs: 60_000 },
    });
    const other = getAdapterCircuitBreakerSingleton({
      phaseRunnerLifetime: {},
      config: { failureThreshold: 2, cooldownMs: 60_000 },
    });

    expect(first).toBe(second);
    expect(other).not.toBe(first);
  });

  test("rejects conflicting singleton config for same lifetime", () => {
    const lifetime = {};
    getAdapterCircuitBreakerSingleton({
      phaseRunnerLifetime: lifetime,
      config: { failureThreshold: 3, cooldownMs: 300_000 },
    });

    expect(() =>
      getAdapterCircuitBreakerSingleton({
        phaseRunnerLifetime: lifetime,
        config: { failureThreshold: 4, cooldownMs: 300_000 },
      }),
    ).toThrow(
      "AdapterCircuitBreaker singleton already exists for this phase-runner lifetime with a different configuration.",
    );
  });
});

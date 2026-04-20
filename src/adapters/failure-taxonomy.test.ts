import { describe, expect, test } from "bun:test";

import { ProcessExecutionError } from "../process";
import { classifyAdapterFailure } from "./failure-taxonomy";
import {
  classifyRecoveryException,
  isRecoverableException,
} from "../engine/exception-recovery";

describe("adapter failure taxonomy", () => {
  test("classifies auth/network/missing-binary/rate_limited/timeout/unknown", () => {
    expect(
      classifyAdapterFailure(new Error("unauthorized: please login")),
    ).toBe("auth");
    expect(
      classifyAdapterFailure({
        code: "ENOTFOUND",
        message: "dns lookup failed",
      }),
    ).toBe("network");
    expect(
      classifyAdapterFailure({ code: "ENOENT", message: "spawn codex ENOENT" }),
    ).toBe("missing-binary");
    expect(
      classifyAdapterFailure(
        new ProcessExecutionError("Command failed", {
          command: "codex",
          args: ["exec"],
          cwd: "/tmp",
          exitCode: 1,
          signal: null,
          stdout: "HTTP 429 from upstream API",
          stderr: "retry after 30 seconds",
          durationMs: 10,
        }),
      ),
    ).toBe("rate_limited");
    expect(
      classifyAdapterFailure(new Error("Command timed out after 10ms")),
    ).toBe("timeout");
    expect(classifyAdapterFailure(new Error("boom"))).toBe("unknown");
  });

  test("detects rate-limit signals across adapter stdout/stderr variants", () => {
    const samples = [
      {
        stdout: "HTTP/1.1 429 Too Many Requests",
        stderr: "",
      },
      {
        stdout: "",
        stderr: "Provider says: rate limit exceeded for this workspace",
      },
      {
        stdout: "request rejected",
        stderr: "retry-after: 120",
      },
      {
        stdout: "",
        stderr: "status code 429 from upstream gateway",
      },
      {
        stdout: "agent stalled",
        stderr: "RATE-LIMIT window exceeded",
      },
      {
        stdout: "You're out of extra usage · resets 5pm (Europe/Berlin)",
        stderr: "",
      },
      {
        stdout:
          "Attempt 1 failed: You have exhausted your capacity on this model. Your quota will reset after 0s.",
        stderr: "",
      },
    ];

    for (const [index, sample] of samples.entries()) {
      expect(
        classifyAdapterFailure(
          new ProcessExecutionError(`rate-limit sample ${index + 1}`, {
            command: "codex",
            args: ["exec"],
            cwd: "/tmp",
            exitCode: 1,
            signal: null,
            stdout: sample.stdout,
            stderr: sample.stderr,
            durationMs: 10,
          }),
        ),
      ).toBe("rate_limited");
    }
  });

  test("recovery policy: auth/missing-binary are not recoverable", () => {
    const auth = classifyRecoveryException({
      message: "Adapter failed: unauthorized",
      category: "AGENT_FAILURE",
      adapterFailureKind: "auth",
    });
    const missing = classifyRecoveryException({
      message: "Adapter failed: ENOENT",
      category: "AGENT_FAILURE",
      adapterFailureKind: "missing-binary",
    });
    const timeout = classifyRecoveryException({
      message: "Adapter failed: timed out",
      category: "AGENT_FAILURE",
      adapterFailureKind: "timeout",
    });
    const rateLimited = classifyRecoveryException({
      message: "Adapter failed: HTTP 429",
      category: "AGENT_FAILURE",
      adapterFailureKind: "rate_limited",
    });

    expect(isRecoverableException(auth)).toBe(false);
    expect(isRecoverableException(missing)).toBe(false);
    expect(isRecoverableException(timeout)).toBe(true);
    expect(isRecoverableException(rateLimited)).toBe(true);
  });
});

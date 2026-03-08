import { describe, expect, test } from "bun:test";

import { classifyAdapterFailure } from "./failure-taxonomy";
import {
  classifyRecoveryException,
  isRecoverableException,
} from "../engine/exception-recovery";

describe("adapter failure taxonomy", () => {
  test("classifies auth/network/missing-binary/timeout/unknown", () => {
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
      classifyAdapterFailure(new Error("Command timed out after 10ms")),
    ).toBe("timeout");
    expect(classifyAdapterFailure(new Error("boom"))).toBe("unknown");
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

    expect(isRecoverableException(auth)).toBe(false);
    expect(isRecoverableException(missing)).toBe(false);
    expect(isRecoverableException(timeout)).toBe(true);
  });
});

import type { CLIAdapterId } from "../types";

import type { NonInteractiveConfig } from "./types";

type StartupCapableAdapterId = Exclude<CLIAdapterId, "MOCK_CLI">;

export type AdapterStartupPolicy = {
  defaultCommand: string;
  requiredBaseArgs: readonly string[];
  nonInteractiveConfig: NonInteractiveConfig;
  startupHint: string;
};

const STARTUP_POLICIES: Record<StartupCapableAdapterId, AdapterStartupPolicy> =
  {
    CODEX_CLI: {
      defaultCommand: "codex",
      requiredBaseArgs: ["exec"],
      nonInteractiveConfig: {
        requiredArgs: ["exec"],
        forbiddenArgs: ["chat", "interactive"],
      },
      startupHint:
        "Run 'codex auth login' (if needed), then verify 'codex exec' works in this shell.",
    },
    CLAUDE_CLI: {
      defaultCommand: "claude",
      requiredBaseArgs: ["--print", "--dangerously-skip-permissions"],
      nonInteractiveConfig: {
        requiredArgs: ["--print"],
        forbiddenArgs: [],
      },
      startupHint:
        "Verify 'claude --print' works in this shell and that Claude credentials are configured.",
    },
    GEMINI_CLI: {
      defaultCommand: "gemini",
      requiredBaseArgs: ["--yolo"],
      nonInteractiveConfig: {
        requiredArgs: ["--yolo"],
        forbiddenArgs: [],
      },
      startupHint:
        "Verify 'gemini --yolo --prompt \"\"' works in this shell and that Gemini credentials are configured.",
    },
  };

export type AdapterInitializationDiagnostic = {
  marker: "ixado.adapter.startup";
  event: "adapter-initialized";
  adapterId: StartupCapableAdapterId;
  command: string;
  baseArgs: string[];
  checks: {
    commandConfigured: "pass";
    nonInteractivePolicy: "pass";
    startupSilenceWatchdogMs: number;
  };
  context: {
    cwd: string;
    timeoutMs: number;
    startupSilenceTimeoutMs: number;
    hint: string;
  };
  message: string;
};

export type AdapterStartupSilenceDiagnostic = {
  marker: "ixado.adapter.startup";
  event: "startup-silence-timeout";
  adapterId: CLIAdapterId | "UNKNOWN";
  command: string;
  startupSilenceTimeoutMs: number;
  hint: string;
  message: string;
};

export function getAdapterStartupPolicy(
  adapterId: CLIAdapterId,
): AdapterStartupPolicy | undefined {
  if (adapterId === "MOCK_CLI") {
    return undefined;
  }

  return STARTUP_POLICIES[adapterId];
}

export function getRequiredAdapterStartupPolicy(
  adapterId: StartupCapableAdapterId,
): AdapterStartupPolicy {
  return STARTUP_POLICIES[adapterId];
}

export function buildAdapterInitializationDiagnostic(input: {
  adapterId: CLIAdapterId;
  command: string;
  baseArgs: string[];
  cwd: string;
  timeoutMs: number;
  startupSilenceTimeoutMs: number;
}): AdapterInitializationDiagnostic | undefined {
  if (input.adapterId === "MOCK_CLI") {
    return undefined;
  }
  const adapterId: StartupCapableAdapterId = input.adapterId;
  const policy = getRequiredAdapterStartupPolicy(adapterId);

  return {
    marker: "ixado.adapter.startup",
    event: "adapter-initialized",
    adapterId,
    command: input.command,
    baseArgs: [...input.baseArgs],
    checks: {
      commandConfigured: "pass",
      nonInteractivePolicy: "pass",
      startupSilenceWatchdogMs: input.startupSilenceTimeoutMs,
    },
    context: {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      startupSilenceTimeoutMs: input.startupSilenceTimeoutMs,
      hint: policy.startupHint,
    },
    message:
      "Adapter initialization checks passed. Runtime startup silence watchdog is active.",
  };
}

export function buildAdapterStartupSilenceDiagnostic(input: {
  adapterId?: CLIAdapterId;
  command: string;
  startupSilenceTimeoutMs: number;
}): AdapterStartupSilenceDiagnostic {
  const adapterId = input.adapterId ?? "UNKNOWN";
  const policy =
    adapterId === "UNKNOWN" ? undefined : getAdapterStartupPolicy(adapterId);

  return {
    marker: "ixado.adapter.startup",
    event: "startup-silence-timeout",
    adapterId,
    command: input.command,
    startupSilenceTimeoutMs: input.startupSilenceTimeoutMs,
    hint:
      policy?.startupHint ??
      "Verify the adapter CLI is installed, on PATH, and authenticated in this shell.",
    message:
      "No process output was received before startup silence timeout elapsed.",
  };
}

export function formatAdapterStartupDiagnostic(
  diagnostic: AdapterInitializationDiagnostic | AdapterStartupSilenceDiagnostic,
): string {
  return `[ixado][adapter-startup] ${JSON.stringify(diagnostic)}`;
}

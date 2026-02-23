import { randomUUID } from "node:crypto";

import { appendAuditLog, computeCommandHash } from "../security/audit-log";
import type { AuthPolicy, Role } from "../security/policy";
import {
  OrchestrationAuthorizationDeniedError,
  authorizeOrchestratorAction,
} from "../security/orchestration-authorizer";
import { ORCHESTRATOR_ACTIONS } from "../security/workflow-profiles";
import {
  ExceptionMetadataSchema,
  ExceptionRecoveryResultSchema,
  RecoveryAttemptRecordSchema,
  type ExceptionMetadata,
  type ExceptionRecoveryResult,
  type RecoveryAttemptRecord,
} from "../types";

export function classifyRecoveryException(input: {
  message: string;
  phaseId?: string;
  taskId?: string;
}): ExceptionMetadata {
  const message = input.message.trim();
  if (!message) {
    throw new Error("Recovery exception message must not be empty.");
  }

  const lower = message.toLowerCase();
  const category = lower.includes("working tree is not clean")
    ? "DIRTY_WORKTREE"
    : lower.includes("requires a commit before push/pr") ||
        lower.includes("could not create commit before push/pr")
      ? "MISSING_COMMIT"
      : lower.includes("adapter") ||
          lower.includes("execution loop stopped after failed task")
        ? "AGENT_FAILURE"
        : "UNKNOWN";

  return ExceptionMetadataSchema.parse({
    category,
    message,
    phaseId: input.phaseId,
    taskId: input.taskId,
  });
}

export function isRecoverableException(exception: ExceptionMetadata): boolean {
  return exception.category !== "UNKNOWN";
}

export function validateRecoveryActions(actionsTaken: string[]): void {
  for (const action of actionsTaken) {
    const normalized = action.trim();
    if (!normalized) {
      throw new Error("Recovery action list contains an empty action.");
    }
    if (!normalized.toLowerCase().startsWith("git ")) {
      continue;
    }

    const lower = normalized.toLowerCase();
    if (lower.startsWith("git push") || lower.startsWith("git rebase")) {
      throw new Error(
        `Recovery action is forbidden by policy guardrails: ${normalized}`,
      );
    }
    if (lower.startsWith("git add") || lower.startsWith("git commit")) {
      continue;
    }

    throw new Error(
      `Recovery action is not allowed by single-path guardrails: ${normalized}`,
    );
  }
}

function extractFirstJsonObject(raw: string): string | null {
  const startIndex = raw.indexOf("{");
  if (startIndex < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = startIndex; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

export function parseRecoveryResultFromOutput(
  rawOutput: string,
): ExceptionRecoveryResult {
  const trimmed = rawOutput.trim();
  if (!trimmed) {
    throw new Error("Recovery adapter returned empty output.");
  }

  const tryParse = (payload: string): ExceptionRecoveryResult | undefined => {
    try {
      const parsed = JSON.parse(payload);
      return ExceptionRecoveryResultSchema.parse(parsed);
    } catch {
      return undefined;
    }
  };

  const direct = tryParse(trimmed);
  if (direct) {
    return direct;
  }

  const fencedMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(rawOutput);
  if (fencedMatch) {
    const fenced = tryParse(fencedMatch[1].trim());
    if (fenced) {
      return fenced;
    }
  }

  const objectPayload = extractFirstJsonObject(rawOutput);
  if (objectPayload) {
    const objectParsed = tryParse(objectPayload);
    if (objectParsed) {
      return objectParsed;
    }
  }

  throw new Error("Recovery adapter output is not contract-compliant JSON.");
}

function buildRecoveryPrompt(input: {
  exception: ExceptionMetadata;
  phaseName?: string;
  taskTitle?: string;
}): string {
  return [
    "You are IxADO recovery worker.",
    "Return ONLY strict JSON that exactly matches this schema:",
    '{"status":"fixed"|"unfixable","reasoning":"string","actionsTaken":["string"],"filesTouched":["string"]}',
    "Rules:",
    '- "status" must be either "fixed" or "unfixable".',
    "- If fixed, list concrete actions and touched files when applicable.",
    "- Never include markdown, comments, code fences, or extra keys.",
    "- Never suggest or perform remote git actions like git push or git rebase.",
    "- Local cleanup actions such as git add and git commit are allowed when needed.",
    "",
    `Exception category: ${input.exception.category}`,
    `Exception message: ${input.exception.message}`,
    `Phase: ${input.phaseName ?? "unknown"}`,
    `Task: ${input.taskTitle ?? "unknown"}`,
  ].join("\n");
}

export type RunExceptionRecoveryInput = {
  cwd: string;
  assignee: "MOCK_CLI" | "CLAUDE_CLI" | "GEMINI_CLI" | "CODEX_CLI";
  exception: ExceptionMetadata;
  attemptNumber: number;
  role: Role | null;
  policy: AuthPolicy;
  phaseName?: string;
  taskTitle?: string;
  runInternalWork: (input: {
    assignee: "MOCK_CLI" | "CLAUDE_CLI" | "GEMINI_CLI" | "CODEX_CLI";
    prompt: string;
    phaseId?: string;
    taskId?: string;
    resume?: boolean;
  }) => Promise<{
    stdout: string;
    stderr: string;
  }>;
};

export async function runExceptionRecovery(
  input: RunExceptionRecoveryInput,
): Promise<RecoveryAttemptRecord> {
  const exception = ExceptionMetadataSchema.parse(input.exception);
  const attemptNumber = Number(input.attemptNumber);
  if (!Number.isInteger(attemptNumber) || attemptNumber <= 0) {
    throw new Error("Recovery attemptNumber must be a positive integer.");
  }

  const decision = await authorizeOrchestratorAction({
    action: ORCHESTRATOR_ACTIONS.EXCEPTION_RECOVERY_RUN,
    auditCwd: input.cwd,
    settingsFilePath: "<in-memory-policy>",
    session: { source: "cli" },
    roleConfig: {},
    loadPolicy: async () => input.policy,
    resolveSessionRole: () => input.role,
  });
  if (decision.decision === "deny") {
    throw new OrchestrationAuthorizationDeniedError(decision);
  }

  const prompt = buildRecoveryPrompt({
    exception,
    phaseName: input.phaseName,
    taskTitle: input.taskTitle,
  });
  await appendAuditLog(input.cwd, {
    actor: "cli:local",
    role: input.role,
    action: "recovery:detected",
    target: exception.taskId ?? exception.phaseId ?? "phase-run",
    decision: "allow",
    reason: exception.category,
    commandHash: computeCommandHash(`recovery-detected-${attemptNumber}`),
  });

  await appendAuditLog(input.cwd, {
    actor: "cli:local",
    role: input.role,
    action: "recovery:adapter-invoked",
    target: input.assignee,
    decision: "allow",
    reason: `attempt:${attemptNumber}`,
    commandHash: computeCommandHash(`recovery-adapter-${input.assignee}`),
  });

  const adapterResult = await input.runInternalWork({
    assignee: input.assignee,
    prompt,
    phaseId: exception.phaseId,
    taskId: exception.taskId,
    resume: true,
  });

  const parsedResult = parseRecoveryResultFromOutput(adapterResult.stdout);
  validateRecoveryActions(parsedResult.actionsTaken ?? []);

  await appendAuditLog(input.cwd, {
    actor: "cli:local",
    role: input.role,
    action: "recovery:parsed-result",
    target: parsedResult.status,
    decision: parsedResult.status === "fixed" ? "allow" : "deny",
    reason: parsedResult.reasoning,
    commandHash: computeCommandHash(`recovery-result-${parsedResult.status}`),
  });

  return RecoveryAttemptRecordSchema.parse({
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    attemptNumber,
    exception,
    result: parsedResult,
  });
}

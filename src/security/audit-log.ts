import { createHash } from "node:crypto";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { Role } from "./policy";

const DEFAULT_AUDIT_LOG_FILE = ".ixado/audit.log";
const MAX_LOG_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_LOG_ROTATIONS = 5;

export type AuditDecision = "allow" | "deny";

export type AuditLogEntry = {
  timestamp: string;
  actor: string;
  role: Role | null;
  action: string;
  target: string;
  decision: AuditDecision;
  reason: string;
  commandHash: string;
};

export type RotationOptions = {
  maxSizeBytes?: number;
  maxRotations?: number;
};

// Patterns that identify known secret/token formats.
// All patterns use the /g flag; lastIndex is reset before each replacement.
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  // GitHub personal access tokens
  /ghp_[A-Za-z0-9_]{36,}/g,
  /gho_[A-Za-z0-9_]{36,}/g,
  /ghs_[A-Za-z0-9_]{36,}/g,
  /github_pat_[A-Za-z0-9_]{36,}/g,
  // Telegram bot token: <8+ digit numeric id>:<35+ char alphanumeric token>
  // No \b anchor — token often appears as "bot<id>:<token>" inside URLs.
  /\d{8,}:[A-Za-z0-9_-]{35,}/g,
  // HTTP Authorization / Bearer header values
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // Common key=value / key:value secret fields (covers env-style names too)
  /(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth(?:orization)?[_-]?token|bearer[_-]?token|secret[_-]?key|private[_-]?key|password|passwd|credential|token)(?:\s*[=:]\s*)["']?[^\s"',;&]{8,}["']?/gi,
  // JSON Web Tokens (header.payload.signature, all base64url-encoded)
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

const REDACTED = "[REDACTED]";

/**
 * Replaces known secret/token patterns in `value` with `[REDACTED]`.
 * Safe to call on arbitrary strings; non-matching content is returned unchanged.
 */
export function redactSensitiveData(value: string): string {
  let result = value;
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0; // reset stateful /g regex before each call
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

function sanitizeEntry(entry: AuditLogEntry): AuditLogEntry {
  return {
    ...entry,
    actor: redactSensitiveData(entry.actor),
    action: redactSensitiveData(entry.action),
    target: redactSensitiveData(entry.target),
    reason: redactSensitiveData(entry.reason),
  };
}

export function resolveAuditLogFilePath(cwd: string): string {
  const configuredPath = process.env.IXADO_AUDIT_LOG_FILE?.trim();
  if (configuredPath) {
    return resolve(configuredPath);
  }

  return resolve(cwd, DEFAULT_AUDIT_LOG_FILE);
}

export function computeCommandHash(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

/**
 * Rotates `logFilePath` if its size has reached or exceeded the threshold.
 *
 * Rotation scheme (N = maxRotations, default 5):
 *   audit.log.N   → dropped (silently)
 *   audit.log.N-1 → audit.log.N
 *   …
 *   audit.log.1   → audit.log.2
 *   audit.log     → audit.log.1
 */
export async function rotateAuditLogIfNeeded(
  logFilePath: string,
  options?: RotationOptions,
): Promise<void> {
  const maxSizeBytes = options?.maxSizeBytes ?? MAX_LOG_FILE_SIZE_BYTES;
  const maxRotations = options?.maxRotations ?? MAX_LOG_ROTATIONS;

  let fileSize: number;
  try {
    const info = await stat(logFilePath);
    fileSize = info.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return; // file does not exist — nothing to rotate
    }
    throw err;
  }

  if (fileSize < maxSizeBytes) {
    return;
  }

  // Shift existing rotated files down one slot; files beyond maxRotations are silently dropped.
  for (let i = maxRotations - 1; i >= 1; i--) {
    try {
      await rename(`${logFilePath}.${i}`, `${logFilePath}.${i + 1}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      // rotated file at slot i does not exist — skip
    }
  }

  await rename(logFilePath, `${logFilePath}.1`);
}

export async function appendAuditLog(
  cwd: string,
  entry: Omit<AuditLogEntry, "timestamp"> & { timestamp?: string },
): Promise<void> {
  const logFilePath = resolveAuditLogFilePath(cwd);
  await mkdir(dirname(logFilePath), { recursive: true });

  const full: AuditLogEntry = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    actor: entry.actor,
    role: entry.role,
    action: entry.action,
    target: entry.target,
    decision: entry.decision,
    reason: entry.reason,
    commandHash: entry.commandHash,
  };

  const safe = sanitizeEntry(full);

  await rotateAuditLogIfNeeded(logFilePath);
  await appendFile(logFilePath, `${JSON.stringify(safe)}\n`, "utf8");
}

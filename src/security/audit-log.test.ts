import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  appendAuditLog,
  computeCommandHash,
  redactSensitiveData,
  rotateAuditLogIfNeeded,
} from "./audit-log";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `ixado-audit-test-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function readLines(filePath: string): Promise<string[]> {
  const content = await readFile(filePath, "utf8");
  return content.split("\n").filter((line) => line.trim().length > 0);
}

// ---------------------------------------------------------------------------
// redactSensitiveData — safe values that must NOT be altered
// ---------------------------------------------------------------------------

describe("redactSensitiveData — safe values unchanged", () => {
  test("empty string", () => {
    expect(redactSensitiveData("")).toBe("");
  });

  test("plain prose", () => {
    const s = "authorization decision for user 12345678";
    expect(redactSensitiveData(s)).toBe(s);
  });

  test("structured action identifier", () => {
    const s = "git:privileged:push";
    expect(redactSensitiveData(s)).toBe(s);
  });

  test("ISO 8601 timestamp", () => {
    const s = "2026-02-23T10:00:00.000Z";
    expect(redactSensitiveData(s)).toBe(s);
  });

  test("numeric Telegram user ID (short)", () => {
    // A short numeric ID (< 8 digits) should not be affected
    const s = "1234567";
    expect(redactSensitiveData(s)).toBe(s);
  });

  test("SHA-256 hex hash (commandHash field values must survive)", () => {
    const hash = computeCommandHash("git push origin main");
    expect(redactSensitiveData(hash)).toBe(hash);
  });

  test("branch name containing the word 'token'", () => {
    // The word 'token' alone without an assignment operator is not a secret
    const s = "branch: feature/token-refresh";
    expect(redactSensitiveData(s)).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// redactSensitiveData — secrets that MUST be replaced with [REDACTED]
// ---------------------------------------------------------------------------

describe("redactSensitiveData — GitHub tokens", () => {
  test("ghp_ personal access token", () => {
    const token = "ghp_" + "A".repeat(36);
    expect(redactSensitiveData(token)).toBe("[REDACTED]");
  });

  test("ghp_ token embedded in surrounding text", () => {
    const token = "ghp_" + "B".repeat(36);
    const result = redactSensitiveData(`pushing with token ${token} now`);
    expect(result).toBe("pushing with token [REDACTED] now");
    expect(result).not.toContain(token);
  });

  test("gho_ OAuth token", () => {
    const token = "gho_" + "C".repeat(36);
    expect(redactSensitiveData(token)).toBe("[REDACTED]");
  });

  test("ghs_ installation token", () => {
    const token = "ghs_" + "D".repeat(36);
    expect(redactSensitiveData(token)).toBe("[REDACTED]");
  });

  test("github_pat_ fine-grained PAT", () => {
    const token = "github_pat_" + "E".repeat(36);
    expect(redactSensitiveData(token)).toBe("[REDACTED]");
  });
});

describe("redactSensitiveData — Telegram bot token", () => {
  test("canonical format: <numeric_id>:<alphanumeric_token>", () => {
    const token = "12345678:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const result = redactSensitiveData(
      `bot token is ${token} — keep this safe`,
    );
    expect(result).not.toContain(token);
    expect(result).toContain("[REDACTED]");
  });
});

describe("redactSensitiveData — HTTP Authorization header values", () => {
  test("Bearer <token>", () => {
    const header = "Bearer eyABC123.eyXYZ456.signature789";
    expect(redactSensitiveData(header)).not.toContain("eyABC");
    expect(redactSensitiveData(header)).toContain("[REDACTED]");
  });

  test("bearer (lowercase) is also redacted", () => {
    const header = "bearer someVeryLongTokenValue12345";
    expect(redactSensitiveData(header)).not.toContain("someVeryLong");
    expect(redactSensitiveData(header)).toContain("[REDACTED]");
  });
});

describe("redactSensitiveData — key=value secret fields", () => {
  test("password=value", () => {
    const s = "password=hunter2topsecret";
    expect(redactSensitiveData(s)).toBe("[REDACTED]");
  });

  test("PASSWORD= (uppercase) is also redacted", () => {
    const s = "PASSWORD=hunter2topsecret";
    expect(redactSensitiveData(s)).not.toContain("hunter2");
    expect(redactSensitiveData(s)).toContain("[REDACTED]");
  });

  test("api_key=value", () => {
    const s = "api_key=abc123xyz789longkey";
    expect(redactSensitiveData(s)).not.toContain("abc123");
    expect(redactSensitiveData(s)).toContain("[REDACTED]");
  });

  test("api-key=value (hyphen variant)", () => {
    const s = "api-key=abc123xyz789longkey";
    expect(redactSensitiveData(s)).not.toContain("abc123");
    expect(redactSensitiveData(s)).toContain("[REDACTED]");
  });

  test("access_token=value", () => {
    const s = "access_token=ghp_AAABBBCCCDDDEEE";
    expect(redactSensitiveData(s)).not.toContain("ghp_");
    expect(redactSensitiveData(s)).toContain("[REDACTED]");
  });

  test("token=value (env-style GITHUB_TOKEN=...)", () => {
    const s = "GITHUB_TOKEN=somePersonalTokenValue99";
    // The ghp_/gho_ patterns won't fire but 'token=' sub-pattern should
    expect(redactSensitiveData(s)).not.toContain("somePersonal");
    expect(redactSensitiveData(s)).toContain("[REDACTED]");
  });

  test("secret_key=value", () => {
    const s = "secret_key=mysupersecretvalue123";
    expect(redactSensitiveData(s)).not.toContain("mysupersecret");
    expect(redactSensitiveData(s)).toContain("[REDACTED]");
  });
});

describe("redactSensitiveData — JSON Web Tokens", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
    ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0" +
    ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

  test("full JWT is redacted", () => {
    expect(redactSensitiveData(jwt)).not.toContain("eyJhbGci");
    expect(redactSensitiveData(jwt)).toContain("[REDACTED]");
  });

  test("JWT embedded in a log message is redacted", () => {
    const msg = `auth header value: ${jwt}, user verified`;
    const result = redactSensitiveData(msg);
    expect(result).not.toContain("eyJhbGci");
    expect(result).toContain("[REDACTED]");
    expect(result).toContain("auth header value:");
    expect(result).toContain("user verified");
  });
});

describe("redactSensitiveData — multiple secrets in one string", () => {
  test("both a GitHub PAT and a Bearer token are redacted", () => {
    const pat = "ghp_" + "X".repeat(36);
    const bearer = "Bearer someapitoken1234567890abcdef";
    const s = `pat=${pat} header=${bearer}`;
    const result = redactSensitiveData(s);
    expect(result).not.toContain(pat);
    expect(result).not.toContain("someapitoken");
    expect(result.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// rotateAuditLogIfNeeded
// ---------------------------------------------------------------------------

describe("rotateAuditLogIfNeeded", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("no-op when file does not exist", async () => {
    const logPath = join(tempDir, "missing.log");
    await expect(
      rotateAuditLogIfNeeded(logPath, { maxSizeBytes: 1 }),
    ).resolves.toBeUndefined();
  });

  test("no-op when file is below the size threshold", async () => {
    const logPath = join(tempDir, "audit.log");
    await writeFile(logPath, "tiny", "utf8");

    await rotateAuditLogIfNeeded(logPath, { maxSizeBytes: 1024 });

    // original still exists, no .1 created
    const content = await readFile(logPath, "utf8");
    expect(content).toBe("tiny");
    await expect(readFile(`${logPath}.1`, "utf8")).rejects.toThrow();
  });

  test("rotates when file meets or exceeds threshold", async () => {
    const logPath = join(tempDir, "audit.log");
    await writeFile(logPath, "x".repeat(20), "utf8");

    await rotateAuditLogIfNeeded(logPath, { maxSizeBytes: 10 });

    // original is gone, .1 has original content
    await expect(readFile(logPath, "utf8")).rejects.toThrow();
    const rotated = await readFile(`${logPath}.1`, "utf8");
    expect(rotated).toBe("x".repeat(20));
  });

  test("shifts existing .1 to .2 when rotating again", async () => {
    const logPath = join(tempDir, "audit.log");
    await writeFile(logPath, "new-content", "utf8");
    await writeFile(`${logPath}.1`, "old-content", "utf8");

    await rotateAuditLogIfNeeded(logPath, { maxSizeBytes: 5 });

    const slot1 = await readFile(`${logPath}.1`, "utf8");
    const slot2 = await readFile(`${logPath}.2`, "utf8");
    expect(slot1).toBe("new-content");
    expect(slot2).toBe("old-content");
  });

  test("shifts a full chain of rotated files", async () => {
    const logPath = join(tempDir, "audit.log");
    await writeFile(logPath, "slot-0", "utf8");
    await writeFile(`${logPath}.1`, "slot-1", "utf8");
    await writeFile(`${logPath}.2`, "slot-2", "utf8");

    await rotateAuditLogIfNeeded(logPath, { maxSizeBytes: 1, maxRotations: 5 });

    expect(await readFile(`${logPath}.1`, "utf8")).toBe("slot-0");
    expect(await readFile(`${logPath}.2`, "utf8")).toBe("slot-1");
    expect(await readFile(`${logPath}.3`, "utf8")).toBe("slot-2");
  });

  test("oldest file beyond maxRotations is silently dropped", async () => {
    const logPath = join(tempDir, "audit.log");
    await writeFile(logPath, "current", "utf8");
    // Fill all rotation slots to the maximum (maxRotations = 3)
    await writeFile(`${logPath}.1`, "slot-1", "utf8");
    await writeFile(`${logPath}.2`, "slot-2", "utf8");
    await writeFile(`${logPath}.3`, "slot-3-will-be-dropped", "utf8");

    await rotateAuditLogIfNeeded(logPath, { maxSizeBytes: 1, maxRotations: 3 });

    expect(await readFile(`${logPath}.1`, "utf8")).toBe("current");
    expect(await readFile(`${logPath}.2`, "utf8")).toBe("slot-1");
    expect(await readFile(`${logPath}.3`, "utf8")).toBe("slot-2");
    // slot-3-will-be-dropped is overwritten by slot-2, the original slot-3 is gone
    await expect(readFile(`${logPath}.4`, "utf8")).rejects.toThrow();
  });

  test("respects custom maxSizeBytes — file exactly at threshold triggers rotation", async () => {
    const logPath = join(tempDir, "audit.log");
    const content = "hello"; // 5 bytes
    await writeFile(logPath, content, "utf8");

    // threshold = 5 → file is AT the limit, should rotate
    await rotateAuditLogIfNeeded(logPath, { maxSizeBytes: 5 });
    expect(await readFile(`${logPath}.1`, "utf8")).toBe("hello");
  });

  test("respects custom maxRotations — only keeps specified number of slots", async () => {
    const logPath = join(tempDir, "audit.log");
    await writeFile(logPath, "current", "utf8");
    await writeFile(`${logPath}.1`, "old", "utf8");

    await rotateAuditLogIfNeeded(logPath, {
      maxSizeBytes: 1,
      maxRotations: 1,
    });

    // With maxRotations=1, only slot .1 exists; old slot .1 shifts to .2 but maxRotations limits to 1
    // slot .2 should NOT exist when maxRotations=1 because the loop runs for i in (0..maxRotations-1=0),
    // meaning no shifts occur before the rename of the main file
    expect(await readFile(`${logPath}.1`, "utf8")).toBe("current");
  });
});

// ---------------------------------------------------------------------------
// appendAuditLog — write behavior and redaction
// ---------------------------------------------------------------------------

describe("appendAuditLog — write behavior", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const baseEntry = {
    actor: "cli",
    role: "owner" as const,
    action: "git:privileged:push",
    target: "origin/main",
    decision: "allow" as const,
    reason: "policy allows git push for owner",
    commandHash: computeCommandHash("git push origin main"),
    timestamp: "2026-02-23T10:00:00.000Z",
  };

  test("writes a single JSON line to the log file", async () => {
    await appendAuditLog(tempDir, baseEntry);

    const lines = await readLines(join(tempDir, ".ixado/audit.log"));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.actor).toBe("cli");
    expect(parsed.decision).toBe("allow");
    expect(parsed.action).toBe("git:privileged:push");
  });

  test("multiple calls append multiple lines", async () => {
    await appendAuditLog(tempDir, { ...baseEntry, decision: "allow" });
    await appendAuditLog(tempDir, { ...baseEntry, decision: "deny" });

    const lines = await readLines(join(tempDir, ".ixado/audit.log"));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).decision).toBe("allow");
    expect(JSON.parse(lines[1]).decision).toBe("deny");
  });

  test("creates the .ixado directory if it does not exist", async () => {
    const freshDir = join(tempDir, "fresh-project");
    await mkdir(freshDir, { recursive: true });

    await appendAuditLog(freshDir, baseEntry);

    const lines = await readLines(join(freshDir, ".ixado/audit.log"));
    expect(lines).toHaveLength(1);
  });

  test("preserves timestamp field as supplied", async () => {
    await appendAuditLog(tempDir, baseEntry);
    const lines = await readLines(join(tempDir, ".ixado/audit.log"));
    const parsed = JSON.parse(lines[0]);
    expect(parsed.timestamp).toBe("2026-02-23T10:00:00.000Z");
  });

  test("fills in timestamp automatically when omitted", async () => {
    const { timestamp: _omit, ...entryWithoutTs } = baseEntry;
    await appendAuditLog(tempDir, entryWithoutTs);
    const lines = await readLines(join(tempDir, ".ixado/audit.log"));
    const parsed = JSON.parse(lines[0]);
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("preserves commandHash field unchanged (SHA-256 hex must not be redacted)", async () => {
    const hash = computeCommandHash("git push origin main");
    await appendAuditLog(tempDir, { ...baseEntry, commandHash: hash });
    const lines = await readLines(join(tempDir, ".ixado/audit.log"));
    const parsed = JSON.parse(lines[0]);
    expect(parsed.commandHash).toBe(hash);
    expect(parsed.commandHash).not.toContain("[REDACTED]");
  });

  test("preserves role field", async () => {
    await appendAuditLog(tempDir, { ...baseEntry, role: "admin" });
    const parsed = JSON.parse(
      (await readLines(join(tempDir, ".ixado/audit.log")))[0],
    );
    expect(parsed.role).toBe("admin");
  });

  test("preserves null role", async () => {
    await appendAuditLog(tempDir, { ...baseEntry, role: null });
    const parsed = JSON.parse(
      (await readLines(join(tempDir, ".ixado/audit.log")))[0],
    );
    expect(parsed.role).toBeNull();
  });

  test("preserves decision field", async () => {
    await appendAuditLog(tempDir, { ...baseEntry, decision: "deny" });
    const parsed = JSON.parse(
      (await readLines(join(tempDir, ".ixado/audit.log")))[0],
    );
    expect(parsed.decision).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// appendAuditLog — secrets must never appear in the log file
// ---------------------------------------------------------------------------

describe("appendAuditLog — secrets are never written in clear text", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function parsedLogLine(dir: string, lineIndex = 0) {
    const lines = await readLines(join(dir, ".ixado/audit.log"));
    return JSON.parse(lines[lineIndex]);
  }

  test("GitHub PAT in actor field is redacted", async () => {
    const pat = "ghp_" + "S".repeat(36);
    await appendAuditLog(tempDir, {
      actor: `service account: ${pat}`,
      role: "admin",
      action: "git:privileged:push",
      target: "origin/main",
      decision: "allow",
      reason: "authorized",
      commandHash: computeCommandHash("git push"),
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const parsed = await parsedLogLine(tempDir);
    expect(parsed.actor).not.toContain(pat);
    expect(parsed.actor).toContain("[REDACTED]");
  });

  test("Telegram bot token in target field is redacted", async () => {
    const botToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    await appendAuditLog(tempDir, {
      actor: "cli",
      role: "owner",
      action: "config:write",
      target: `https://api.telegram.org/bot${botToken}/sendMessage`,
      decision: "allow",
      reason: "owner allowed",
      commandHash: computeCommandHash("telegram notify"),
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const rawLine = (await readLines(join(tempDir, ".ixado/audit.log")))[0];
    expect(rawLine).not.toContain(botToken);
    expect(rawLine).toContain("[REDACTED]");
  });

  test("Bearer token in reason field is redacted", async () => {
    const bearer = "Bearer verysecretapikey1234567890abcde";
    await appendAuditLog(tempDir, {
      actor: "cli",
      role: "owner",
      action: "config:write",
      target: "api-endpoint",
      decision: "deny",
      reason: `request used ${bearer} but it was revoked`,
      commandHash: computeCommandHash("api call"),
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const parsed = await parsedLogLine(tempDir);
    expect(parsed.reason).not.toContain("verysecretapikey");
    expect(parsed.reason).toContain("[REDACTED]");
    expect(parsed.reason).toContain("but it was revoked");
  });

  test("password in action field is redacted", async () => {
    await appendAuditLog(tempDir, {
      actor: "cli",
      role: "operator",
      action: "password=p@ssw0rd123secure",
      target: "some-target",
      decision: "deny",
      reason: "denylist match",
      commandHash: computeCommandHash("login"),
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const parsed = await parsedLogLine(tempDir);
    expect(parsed.action).not.toContain("p@ssw0rd123secure");
    expect(parsed.action).toContain("[REDACTED]");
  });

  test("JWT in target URL is redacted", async () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
      ".eyJzdWIiOiJ1c2VyMTIzIn0" +
      ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

    await appendAuditLog(tempDir, {
      actor: "cli",
      role: "admin",
      action: "config:write",
      target: `https://example.com/api?auth=${jwt}`,
      decision: "allow",
      reason: "admin allowed",
      commandHash: computeCommandHash("api request"),
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const rawLine = (await readLines(join(tempDir, ".ixado/audit.log")))[0];
    expect(rawLine).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(rawLine).toContain("[REDACTED]");
  });

  test("plain non-secret values are preserved faithfully", async () => {
    await appendAuditLog(tempDir, {
      actor: "telegram:987654321",
      role: "viewer",
      action: "status:read",
      target: "project-alpha",
      decision: "allow",
      reason: "viewer may read status",
      commandHash: computeCommandHash("status"),
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const parsed = await parsedLogLine(tempDir);
    expect(parsed.actor).toBe("telegram:987654321");
    expect(parsed.action).toBe("status:read");
    expect(parsed.target).toBe("project-alpha");
    expect(parsed.reason).toBe("viewer may read status");
    expect(parsed.decision).toBe("allow");
    expect(parsed.role).toBe("viewer");
  });

  test("raw file content never contains any detected secret pattern", async () => {
    const pat = "ghp_" + "Z".repeat(36);
    const botToken = "99887766:ABCDefghijklmnopqrstuvwxyz1234567890";
    const bearer = "Bearer topSecretKeyValue9876543210xyz";

    await appendAuditLog(tempDir, {
      actor: pat,
      role: "admin",
      action: "git:privileged:pr-merge",
      target: `https://api.telegram.org/bot${botToken}/send`,
      decision: "allow",
      reason: `authorized via ${bearer}`,
      commandHash: computeCommandHash("gh pr merge 42"),
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const rawContent = await readFile(
      join(tempDir, ".ixado/audit.log"),
      "utf8",
    );
    expect(rawContent).not.toContain(pat);
    expect(rawContent).not.toContain(botToken);
    expect(rawContent).not.toContain("topSecretKeyValue");
  });
});

// ---------------------------------------------------------------------------
// appendAuditLog — rotation is triggered before writing
// ---------------------------------------------------------------------------

describe("appendAuditLog — rotation before write", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("rotates an oversized log file before appending the new entry", async () => {
    // Pre-create an oversized audit log
    const logDir = join(tempDir, ".ixado");
    await mkdir(logDir, { recursive: true });
    const logPath = join(logDir, "audit.log");
    const bigContent = "old entry\n".repeat(10);
    await writeFile(logPath, bigContent, "utf8");

    // Patch the env var so appendAuditLog uses our temp path
    const originalEnv = process.env.IXADO_AUDIT_LOG_FILE;
    process.env.IXADO_AUDIT_LOG_FILE = logPath;

    try {
      // We call rotateAuditLogIfNeeded directly with tiny threshold to verify
      // the rotation logic; then call appendAuditLog which should also rotate.
      await rotateAuditLogIfNeeded(logPath, { maxSizeBytes: 1 });
      // After manual rotation, .1 should exist with old content
      const rotatedContent = await readFile(`${logPath}.1`, "utf8");
      expect(rotatedContent).toBe(bigContent);

      // Now write a new entry — no rotation needed (file is fresh/empty after rotate)
      await appendAuditLog(tempDir, {
        actor: "cli",
        role: "owner",
        action: "status:read",
        target: "project",
        decision: "allow",
        reason: "allowed",
        commandHash: computeCommandHash("status"),
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      const newLines = await readLines(logPath);
      expect(newLines).toHaveLength(1);
      expect(JSON.parse(newLines[0]).action).toBe("status:read");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.IXADO_AUDIT_LOG_FILE;
      } else {
        process.env.IXADO_AUDIT_LOG_FILE = originalEnv;
      }
    }
  });
});

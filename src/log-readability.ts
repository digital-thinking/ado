/**
 * ixado system diagnostic prefix — lines starting with this are internal
 * telemetry and must never be suppressed from user-facing streams.
 */
const IXADO_LOG_PREFIX = "[ixado][";

/**
 * Keywords that indicate terminal outcome context (errors, failures, timeouts).
 * Lines containing these are always preserved so operators can diagnose
 * problems even after filtering.
 */
const TERMINAL_CONTEXT_RE =
  /\b(error|fail(?:ed|ure)?|exception|timeout|timed?\s*out|exit\s+code|abort|crash|unauthorized|forbidden|denied|warning)\b/i;

/**
 * File-interaction verbs commonly emitted by AI coding CLI adapters when
 * invoking tools (Read, Write, Edit, List, Bash, etc.).  Matches lines where
 * one of these verbs is the leading content — optionally preceded by bullet
 * symbols or whitespace — followed by a path, a function-call open paren, or
 * a colon (e.g. "Bash: cat file").
 */
const FILE_INTERACTION_LINE_RE =
  /^[\s\W]{0,8}(read(?:ing)?|wrote|writ(?:e|ing)?|edit(?:ed|ing)?|list(?:ed|ing)?|creat(?:e|ed|ing)?|delet(?:e|ed|ing)?|remov(?:e|ed|ing)?|mov(?:e|ed|ing)?|cop(?:y|ied|ying)?|search(?:ed|ing)?|grep(?:ped|ping)?|glob(?:bed|bing)?|find(?:ing)?|ran|run(?:ning)?|exec(?:ut(?:e|ed|ing))?|bash|tool(?:\s+call)?)\s*(?:\(|\s+(?:\/|\.\/|~\/|\w+\/|\w+\.\w{2,6})|:\s)/i;

/**
 * Lines whose entire content is a file path (optional leading symbols, then a
 * path starting with `/`, `./`, or `~/`, nothing else on the line).
 */
const STANDALONE_PATH_LINE_RE = /^\s*[\W]{0,4}\s*(?:\/|\.\/|~\/)\S+\s*$/;

/**
 * Patch diff lines emitted by AI adapters using `apply_patch` or similar
 * unified-diff tools.  Matches:
 *   - `+<code>` / `-<code>` — added/removed lines in a patch hunk.
 *     A bare `- ` (dash-space) is a markdown bullet, NOT a patch line, so we
 *     require that `-` is followed by a non-space or is at end-of-content.
 *   - `@@ -N,N +N,N @@` — hunk header lines.
 *   - `*** Begin Patch` / `*** End Patch` / `*** Update File:` etc. — the
 *     apply_patch protocol markers used by Codex CLI.
 */
const PATCH_PLUS_LINE_RE = /^\+/;
// Filters `-code` and `-    code` (patch removals) but preserves `- word`
// (markdown bullet: dash + single space + word character).
const PATCH_MINUS_LINE_RE = /^-(?! \w)/;
const PATCH_HUNK_RE = /^@@\s+-\d/;
const PATCH_MARKER_RE =
  /^\*\*\* (?:Begin Patch|End Patch|(?:Update|Add|Delete) File:)/;

/**
 * Raw JSON object blobs — long lines starting with `{` that are clearly
 * machine-generated state dumps rather than human-readable reasoning.
 * We only suppress when the line is longer than 200 chars to avoid filtering
 * short structured log messages.
 */
const JSON_BLOB_RE = /^\{.{200}/;

/**
 * Returns `true` when `line` is a low-signal file-interaction chatter line
 * that should be suppressed from user-facing agent log streams.
 *
 * Preserved (returns `false`):
 *   - ixado system diagnostics (`[ixado][…`)
 *   - Lines containing error / failure / timeout keywords
 *   - All other text (reasoning, progress updates)
 *
 * Filtered (returns `true`):
 *   - Tool-invocation lines: verb + path/call (e.g. `Read /src/file.ts`,
 *     `● Edit(file_path: "…")`, `Bash: ls -la`)
 *   - Standalone file-path lines (e.g. `/path/to/file.ts`)
 *   - Patch diff lines from apply_patch / unified-diff output
 *   - Raw JSON state blobs (lines starting with `{` and > 200 chars)
 */
export function isFileInteractionChatter(line: string): boolean {
  if (line.startsWith(IXADO_LOG_PREFIX)) {
    return false;
  }
  if (TERMINAL_CONTEXT_RE.test(line)) {
    return false;
  }
  if (FILE_INTERACTION_LINE_RE.test(line)) {
    return true;
  }
  if (STANDALONE_PATH_LINE_RE.test(line)) {
    return true;
  }
  if (
    PATCH_PLUS_LINE_RE.test(line) ||
    PATCH_MINUS_LINE_RE.test(line) ||
    PATCH_HUNK_RE.test(line) ||
    PATCH_MARKER_RE.test(line)
  ) {
    return true;
  }
  if (JSON_BLOB_RE.test(line)) {
    return true;
  }
  return false;
}

export type RecoveryAttemptLike = {
  id?: string;
  attemptNumber?: number;
  result?: {
    status?: string;
    reasoning?: string;
  };
};

export type LogTaskContext = {
  phaseId?: string;
  phaseName?: string;
  taskId?: string;
  taskTitle?: string;
  taskNumber?: number;
};

export type RecoveryTraceLink = {
  label: string;
  href: string;
};

const MAX_SUMMARY_LENGTH = 140;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function summarizeFailure(
  raw: string | undefined,
  fallback = "No failure details available.",
): string {
  const value = raw?.trim();
  if (!value) {
    return fallback;
  }

  const lines = value
    .split(/\r?\n/)
    .map((line) => compactWhitespace(line))
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return fallback;
  }

  const preferred =
    lines.find((line) =>
      /\b(error|failed|exception|timeout|exit code|unauthorized|denied)\b/i.test(
        line,
      ),
    ) ?? lines[0];

  if (preferred.length <= MAX_SUMMARY_LENGTH) {
    return preferred;
  }

  return `${preferred.slice(0, MAX_SUMMARY_LENGTH - 3)}...`;
}

const MAX_CONTEXT_SEGMENT_LEN = 22;

function truncateSegment(value: string): string {
  if (value.length <= MAX_CONTEXT_SEGMENT_LEN) {
    return value;
  }
  return `${value.slice(0, MAX_CONTEXT_SEGMENT_LEN - 1).trimEnd()}\u2026`;
}

export function formatPhaseTaskContext(context: LogTaskContext): string | null {
  const segments: string[] = [];

  if (context.phaseName) {
    segments.push(truncateSegment(context.phaseName));
  } else if (context.phaseId) {
    segments.push(truncateSegment(context.phaseId));
  }

  if (typeof context.taskNumber === "number") {
    const title = context.taskTitle
      ? ` ${truncateSegment(context.taskTitle)}`
      : "";
    segments.push(`#${context.taskNumber}${title}`);
  } else if (context.taskTitle) {
    segments.push(truncateSegment(context.taskTitle));
  } else if (context.taskId) {
    segments.push(truncateSegment(context.taskId));
  }

  if (segments.length === 0) {
    return null;
  }

  return segments.join(" | ");
}

export function toAnchorToken(raw: string): string {
  const compact = raw.trim();
  if (!compact) {
    return "unknown";
  }

  return compact
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function buildRecoveryTraceLinks(input: {
  context: LogTaskContext;
  attempts?: RecoveryAttemptLike[];
}): RecoveryTraceLink[] {
  const taskToken = input.context.taskId
    ? toAnchorToken(input.context.taskId)
    : undefined;
  if (!taskToken) {
    return [];
  }

  const links: RecoveryTraceLink[] = [
    {
      label: "Task card",
      href: `#task-card-${taskToken}`,
    },
  ];

  const attempts = Array.isArray(input.attempts) ? input.attempts : [];
  if (attempts.length === 0) {
    return links;
  }

  const latest = attempts[attempts.length - 1];
  const attemptRef =
    typeof latest?.attemptNumber === "number" && latest.attemptNumber > 0
      ? latest.attemptNumber
      : attempts.length;
  links.push({
    label: `Recovery attempt ${attemptRef}`,
    href: `#task-recovery-${taskToken}-${attemptRef}`,
  });

  links.push({
    label: "Recovery history",
    href: `#task-recovery-${taskToken}`,
  });

  return links;
}

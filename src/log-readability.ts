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

export function formatPhaseTaskContext(context: LogTaskContext): string | null {
  const segments: string[] = [];

  if (context.phaseName) {
    segments.push(`phase: ${context.phaseName}`);
  } else if (context.phaseId) {
    segments.push(`phase: ${context.phaseId}`);
  }

  if (typeof context.taskNumber === "number") {
    const title = context.taskTitle ? ` ${context.taskTitle}` : "";
    segments.push(`task #${context.taskNumber}${title}`);
  } else if (context.taskTitle) {
    segments.push(`task: ${context.taskTitle}`);
  } else if (context.taskId) {
    segments.push(`task: ${context.taskId}`);
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

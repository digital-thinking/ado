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

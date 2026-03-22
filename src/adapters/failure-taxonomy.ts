export const ADAPTER_FAILURE_KINDS = [
  "auth",
  "network",
  "missing-binary",
  "rate_limited",
  "timeout",
  "unknown",
] as const;

export type AdapterFailureKind = (typeof ADAPTER_FAILURE_KINDS)[number];

const NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND",
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

function collectFailureText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  const parts: string[] = [];
  if (error instanceof Error && error.message) {
    parts.push(error.message);
  } else if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    parts.push((error as { message: string }).message);
  } else {
    parts.push(String(error ?? ""));
  }

  if (
    error &&
    typeof error === "object" &&
    "result" in error &&
    (error as { result?: unknown }).result &&
    typeof (error as { result?: unknown }).result === "object"
  ) {
    const result = (
      error as {
        result?: { stdout?: unknown; stderr?: unknown };
      }
    ).result;
    if (typeof result?.stdout === "string" && result.stdout.trim()) {
      parts.push(result.stdout);
    }
    if (typeof result?.stderr === "string" && result.stderr.trim()) {
      parts.push(result.stderr);
    }
  }

  return parts.join("\n");
}

export function classifyAdapterFailure(error: unknown): AdapterFailureKind {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "").toUpperCase()
      : "";
  const message = collectFailureText(error);

  const lower = message.toLowerCase();

  if (
    lower.includes("rate limit") ||
    lower.includes("rate-limit") ||
    lower.includes("out of extra usage") ||
    lower.includes("usage resets") ||
    lower.includes("exhausted your capacity") ||
    lower.includes("quota will reset") ||
    lower.includes("too many requests") ||
    lower.includes("retry after") ||
    lower.includes("retry-after") ||
    /\bhttp(?:\/\d+(?:\.\d+)?)?\s*429\b/.test(lower) ||
    /\bstatus(?:\s+code)?\s*429\b/.test(lower) ||
    (lower.includes("429") && lower.includes("too many requests"))
  ) {
    return "rate_limited";
  }

  if (
    code === "ETIMEDOUT" ||
    lower.includes("timed out") ||
    lower.includes("timeout")
  ) {
    return "timeout";
  }

  if (
    code === "ENOENT" ||
    lower.includes("command not found") ||
    lower.includes("not recognized as an internal or external command") ||
    lower.includes("uv_spawn")
  ) {
    return "missing-binary";
  }

  if (
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("authentication") ||
    lower.includes("auth") ||
    lower.includes("invalid api key") ||
    lower.includes("api key") ||
    lower.includes("token expired") ||
    lower.includes("permission denied") ||
    lower.includes("credential")
  ) {
    return "auth";
  }

  if (
    NETWORK_ERROR_CODES.has(code) ||
    lower.includes("network") ||
    lower.includes("connection reset") ||
    lower.includes("connection refused") ||
    lower.includes("name resolution") ||
    lower.includes("dns") ||
    lower.includes("temporarily unavailable")
  ) {
    return "network";
  }

  return "unknown";
}

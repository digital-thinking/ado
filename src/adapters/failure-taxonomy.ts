export const ADAPTER_FAILURE_KINDS = [
  "auth",
  "network",
  "missing-binary",
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

export function classifyAdapterFailure(error: unknown): AdapterFailureKind {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "").toUpperCase()
      : "";
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error ?? "");

  const lower = message.toLowerCase();

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

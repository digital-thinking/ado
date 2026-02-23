export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function text(
  content: string,
  status = 200,
  contentType = "text/plain; charset=utf-8",
): Response {
  return new Response(content, {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
    },
  });
}

export async function readJson(
  request: Request,
): Promise<Record<string, unknown>> {
  const payload = (await request.json()) as Record<string, unknown>;
  if (!payload || typeof payload !== "object") {
    throw new Error("Request payload must be a JSON object.");
  }

  return payload;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export type InternalAdapterAssignee =
  | "MOCK_CLI"
  | "CODEX_CLI"
  | "GEMINI_CLI"
  | "CLAUDE_CLI";

export function asInternalAdapterAssignee(
  value: unknown,
): InternalAdapterAssignee | undefined {
  if (
    value === "MOCK_CLI" ||
    value === "CODEX_CLI" ||
    value === "GEMINI_CLI" ||
    value === "CLAUDE_CLI"
  ) {
    return value;
  }

  return undefined;
}

import type { CLIAdapterId } from "../../types";

export function ensureAllowedAssignee(
  assignee: CLIAdapterId,
  availableAssignees: CLIAdapterId[],
): void {
  if (!availableAssignees.includes(assignee)) {
    throw new Error(
      `assignee '${assignee}' is disabled. Available: ${availableAssignees.join(", ")}.`,
    );
  }
}

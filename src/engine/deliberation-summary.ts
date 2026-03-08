import { z } from "zod";

import type { DeliberationSummary } from "./deliberation-pass";

const DELIBERATION_SUMMARY_HEADER = "Deliberation summary:";

const DeliberationRoundSchema = z.object({
  round: z.number().int().positive(),
  proposal: z.string().min(1),
  verdict: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
  comments: z.array(z.string()),
});

const DeliberationSummarySchema = z.object({
  taskId: z.string().min(1),
  taskTitle: z.string().min(1),
  implementerAssignee: z.string().min(1),
  reviewerAssignee: z.string().min(1),
  maxRefinePasses: z.number().int().positive(),
  refinePassesUsed: z.number().int().min(0),
  finalVerdict: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
  rounds: z.array(DeliberationRoundSchema),
  pendingComments: z.array(z.string()),
});

export type ParsedDeliberationSummary = z.infer<
  typeof DeliberationSummarySchema
>;

export function formatDeliberationSummaryForResultContext(
  summary: DeliberationSummary,
): string {
  return [DELIBERATION_SUMMARY_HEADER, JSON.stringify(summary, null, 2)].join(
    "\n",
  );
}

export function parseDeliberationSummaryFromResultContext(
  resultContext?: string,
): ParsedDeliberationSummary | undefined {
  const trimmedResultContext = resultContext?.trim();
  if (!trimmedResultContext) {
    return undefined;
  }
  if (!trimmedResultContext.startsWith(DELIBERATION_SUMMARY_HEADER)) {
    return undefined;
  }

  const afterHeader = trimmedResultContext
    .slice(DELIBERATION_SUMMARY_HEADER.length)
    .trimStart();
  if (!afterHeader.startsWith("{")) {
    return undefined;
  }

  const summaryBoundary = afterHeader.indexOf("\n\n");
  const jsonCandidate =
    summaryBoundary >= 0
      ? afterHeader.slice(0, summaryBoundary).trim()
      : afterHeader.trim();

  try {
    return DeliberationSummarySchema.parse(JSON.parse(jsonCandidate));
  } catch {
    return undefined;
  }
}

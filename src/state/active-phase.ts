import type { Phase, ProjectState } from "../types";

export type ActivePhaseResolutionErrorCode =
  | "NO_PHASES"
  | "ACTIVE_PHASE_ID_MISSING"
  | "ACTIVE_PHASE_ID_NOT_FOUND";

export class ActivePhaseResolutionError extends Error {
  readonly code: ActivePhaseResolutionErrorCode;
  readonly activePhaseId: string | undefined;

  constructor(input: {
    code: ActivePhaseResolutionErrorCode;
    message: string;
    activePhaseId?: string;
  }) {
    super(input.message);
    this.name = "ActivePhaseResolutionError";
    this.code = input.code;
    this.activePhaseId = input.activePhaseId;
  }
}

export function resolvePrimaryActivePhaseId(
  state: Pick<ProjectState, "activePhaseIds">,
): string | undefined {
  const activePhaseIds = Array.isArray(state.activePhaseIds)
    ? state.activePhaseIds
    : [];
  for (const candidate of activePhaseIds) {
    const normalized = candidate.trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return undefined;
}

// Active phase selection policy is strict: no implicit fallback to phases[0].
export function resolveActivePhaseStrict(
  state: Pick<ProjectState, "phases" | "activePhaseIds">,
): Phase {
  if (state.phases.length === 0) {
    throw new ActivePhaseResolutionError({
      code: "NO_PHASES",
      message: "No phases found in project state.",
    });
  }

  const activePhaseId = resolvePrimaryActivePhaseId(state);
  if (!activePhaseId) {
    throw new ActivePhaseResolutionError({
      code: "ACTIVE_PHASE_ID_MISSING",
      message: "Active phase ID is not set in project state.",
    });
  }

  const phase = state.phases.find(
    (candidate) => candidate.id === activePhaseId,
  );
  if (!phase) {
    throw new ActivePhaseResolutionError({
      code: "ACTIVE_PHASE_ID_NOT_FOUND",
      message: `Active phase ID "${activePhaseId}" not found in project state.`,
      activePhaseId,
    });
  }

  return phase;
}

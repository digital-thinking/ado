/**
 * Task-scoped allowlist profiles for common orchestrator workflows.
 *
 * Each profile groups the `ACTIONS` constants into a named permission scope
 * that describes a coherent unit of work the orchestration engine can perform.
 * Profiles are strictly cumulative: each higher-privilege profile includes all
 * actions from every lower-privilege profile.
 *
 * Profiles (least → most permissive):
 *   readonly   – read-only informational queries (status, tasks, logs, usage)
 *   planning   – readonly + project / phase / task management writes
 *   execution  – planning + execution lifecycle controls and automated
 *                tester / CI-validation workflows
 *   privileged – execution + git branch/push/PR operations, agent management,
 *                and system config writes
 *
 * Usage pattern:
 *   1. The orchestrator tags each of its operations with an OrchestratorAction.
 *   2. ORCHESTRATOR_ACTION_PROFILE_MAP maps every OrchestratorAction to the
 *      minimum WorkflowProfile required to execute it.
 *   3. Before executing the operation, check that the actor's resolved role
 *      satisfies all ACTIONS included in the required profile (using the
 *      authorization evaluator and loaded policy).
 */

import { ACTIONS, type ActionName, type AuthPolicy, type Role } from "./policy";
import { isAuthorized } from "./auth-evaluator";

// ---------------------------------------------------------------------------
// Profile names
// ---------------------------------------------------------------------------

export type WorkflowProfileName = "readonly" | "planning" | "execution" | "privileged";

// ---------------------------------------------------------------------------
// Profile type
// ---------------------------------------------------------------------------

export type WorkflowProfile = {
  /** Stable identifier for this profile. */
  name: WorkflowProfileName;

  /** Human-readable description of the intended use case. */
  description: string;

  /**
   * The complete set of ACTIONS constants a role must be able to perform to
   * satisfy this profile.  Includes all actions from lower-tier profiles.
   */
  actions: ReadonlyArray<ActionName>;
};

// ---------------------------------------------------------------------------
// Profile definitions (cumulative)
// ---------------------------------------------------------------------------

/** Read-only informational queries.  Safe for the viewer role and above. */
export const READONLY_PROFILE: WorkflowProfile = {
  name: "readonly",
  description:
    "Read-only informational queries: project status, task lists, execution logs, and usage data.",
  actions: [
    ACTIONS.STATUS_READ,
    ACTIONS.TASKS_READ,
    ACTIONS.LOGS_READ,
    ACTIONS.USAGE_READ,
  ],
};

/**
 * Extends readonly with project / phase / task management writes.
 * Minimum role: operator.
 */
export const PLANNING_PROFILE: WorkflowProfile = {
  name: "planning",
  description:
    "All readonly actions plus creation and updates of phases and tasks.",
  actions: [
    ...READONLY_PROFILE.actions,
    ACTIONS.PHASE_CREATE,
    ACTIONS.TASK_CREATE,
    ACTIONS.TASK_UPDATE,
  ],
};

/**
 * Extends planning with execution lifecycle controls and automated
 * tester / CI-validation workflows.
 * Minimum role: operator.
 */
export const EXECUTION_PROFILE: WorkflowProfile = {
  name: "execution",
  description:
    "All planning actions plus execution controls (start/stop/next) and automated " +
    "tester and CI-validation workflows.",
  actions: [
    ...PLANNING_PROFILE.actions,
    ACTIONS.EXECUTION_START,
    ACTIONS.EXECUTION_STOP,
    ACTIONS.EXECUTION_NEXT,
  ],
};

/**
 * Extends execution with privileged git / PR operations, agent management,
 * and system configuration writes.
 * Minimum role: admin.
 */
export const PRIVILEGED_PROFILE: WorkflowProfile = {
  name: "privileged",
  description:
    "All execution actions plus git branch/push/rebase, PR open/merge, " +
    "agent kill/restart, and config writes.",
  actions: [
    ...EXECUTION_PROFILE.actions,
    ACTIONS.GIT_BRANCH_CREATE,
    ACTIONS.GIT_PUSH,
    ACTIONS.GIT_REBASE,
    ACTIONS.GIT_PR_OPEN,
    ACTIONS.GIT_PR_MERGE,
    ACTIONS.CONFIG_WRITE,
    ACTIONS.AGENT_KILL,
    ACTIONS.AGENT_RESTART,
  ],
};

/** All profiles ordered from least to most permissive. */
export const WORKFLOW_PROFILES: ReadonlyArray<WorkflowProfile> = [
  READONLY_PROFILE,
  PLANNING_PROFILE,
  EXECUTION_PROFILE,
  PRIVILEGED_PROFILE,
];

// ---------------------------------------------------------------------------
// Orchestrator action identifiers
// ---------------------------------------------------------------------------

/**
 * Discrete operation identifiers used by the orchestration engine.
 *
 * Naming convention: `orchestrator:<subsystem>:<verb>`.
 * Every identifier must have an entry in ORCHESTRATOR_ACTION_PROFILE_MAP.
 */
export const ORCHESTRATOR_ACTIONS = {
  // ── Read-only informational queries ───────────────────────────────────────
  STATUS_READ:          "orchestrator:status:read",
  TASKS_READ:           "orchestrator:tasks:read",
  LOGS_READ:            "orchestrator:logs:read",
  USAGE_READ:           "orchestrator:usage:read",

  // ── Project / phase / task management ─────────────────────────────────────
  PHASE_CREATE:         "orchestrator:phase:create",
  TASK_CREATE:          "orchestrator:task:create",
  TASK_UPDATE:          "orchestrator:task:update",

  // ── Execution lifecycle ───────────────────────────────────────────────────
  EXECUTION_START:      "orchestrator:execution:start",
  EXECUTION_STOP:       "orchestrator:execution:stop",
  EXECUTION_NEXT:       "orchestrator:execution:next",

  /**
   * Run the automated test suite after a task completes.
   * May create fix tasks internally (requires task:create from planning).
   */
  TESTER_RUN:           "orchestrator:tester:run",

  /**
   * Run the CI review / fix validation loop after a phase completes.
   * Drives the Reviewer and Fixer worker archetypes.
   */
  CI_VALIDATION_RUN:    "orchestrator:ci-validation:run",

  // ── Privileged git / VCS ──────────────────────────────────────────────────
  GIT_BRANCH_CREATE:    "orchestrator:git:branch-create",
  GIT_PUSH:             "orchestrator:git:push",
  GIT_REBASE:           "orchestrator:git:rebase",

  /** Open a pull request for the completed phase branch. */
  GIT_PR_OPEN:          "orchestrator:git:pr-open",
  GIT_PR_MERGE:         "orchestrator:git:pr-merge",

  /**
   * Full CI integration flow: push branch + open PR.
   * Wraps GIT_PUSH and GIT_PR_OPEN as a single orchestrated step.
   */
  CI_INTEGRATION_RUN:   "orchestrator:ci-integration:run",

  // ── Agent management ──────────────────────────────────────────────────────
  AGENT_KILL:           "orchestrator:agent:kill",
  AGENT_RESTART:        "orchestrator:agent:restart",

  // ── System configuration ──────────────────────────────────────────────────
  CONFIG_WRITE:         "orchestrator:config:write",
} as const;

export type OrchestratorAction =
  (typeof ORCHESTRATOR_ACTIONS)[keyof typeof ORCHESTRATOR_ACTIONS];

// ---------------------------------------------------------------------------
// Mapping: orchestrator action → required workflow profile
// ---------------------------------------------------------------------------

/**
 * Maps every {@link OrchestratorAction} to the {@link WorkflowProfileName}
 * that represents the minimum permission scope required to execute it.
 *
 * Invariant: every value in ORCHESTRATOR_ACTIONS must have an entry here.
 * Compile-time enforcement: the Record key type is `OrchestratorAction`.
 */
export const ORCHESTRATOR_ACTION_PROFILE_MAP: Readonly<
  Record<OrchestratorAction, WorkflowProfileName>
> = {
  // readonly
  [ORCHESTRATOR_ACTIONS.STATUS_READ]:         "readonly",
  [ORCHESTRATOR_ACTIONS.TASKS_READ]:          "readonly",
  [ORCHESTRATOR_ACTIONS.LOGS_READ]:           "readonly",
  [ORCHESTRATOR_ACTIONS.USAGE_READ]:          "readonly",

  // planning
  [ORCHESTRATOR_ACTIONS.PHASE_CREATE]:        "planning",
  [ORCHESTRATOR_ACTIONS.TASK_CREATE]:         "planning",
  [ORCHESTRATOR_ACTIONS.TASK_UPDATE]:         "planning",

  // execution
  [ORCHESTRATOR_ACTIONS.EXECUTION_START]:     "execution",
  [ORCHESTRATOR_ACTIONS.EXECUTION_STOP]:      "execution",
  [ORCHESTRATOR_ACTIONS.EXECUTION_NEXT]:      "execution",
  // Tester may create fix tasks (needs task:create), so it requires execution
  // which already subsumes planning (includes task:create).
  [ORCHESTRATOR_ACTIONS.TESTER_RUN]:          "execution",
  // CI validation drives agent workflows; no external git ops required here.
  [ORCHESTRATOR_ACTIONS.CI_VALIDATION_RUN]:   "execution",

  // privileged
  [ORCHESTRATOR_ACTIONS.GIT_BRANCH_CREATE]:   "privileged",
  [ORCHESTRATOR_ACTIONS.GIT_PUSH]:            "privileged",
  [ORCHESTRATOR_ACTIONS.GIT_REBASE]:          "privileged",
  [ORCHESTRATOR_ACTIONS.GIT_PR_OPEN]:         "privileged",
  [ORCHESTRATOR_ACTIONS.GIT_PR_MERGE]:        "privileged",
  // CI integration = push + PR open, so inherits the privileged requirement.
  [ORCHESTRATOR_ACTIONS.CI_INTEGRATION_RUN]:  "privileged",
  [ORCHESTRATOR_ACTIONS.AGENT_KILL]:          "privileged",
  [ORCHESTRATOR_ACTIONS.AGENT_RESTART]:       "privileged",
  [ORCHESTRATOR_ACTIONS.CONFIG_WRITE]:        "privileged",
};

// ---------------------------------------------------------------------------
// Profile lookup helpers
// ---------------------------------------------------------------------------

/**
 * Returns the {@link WorkflowProfile} for the given profile name.
 * Throws if the name is not found (should be unreachable with typed inputs).
 */
export function getProfileByName(name: WorkflowProfileName): WorkflowProfile {
  const profile = WORKFLOW_PROFILES.find((p) => p.name === name);
  if (!profile) {
    throw new Error(`Unknown workflow profile: ${name}`);
  }
  return profile;
}

/**
 * Returns the {@link WorkflowProfile} required by the given orchestrator action.
 */
export function getProfileForOrchestratorAction(
  action: OrchestratorAction,
): WorkflowProfile {
  return getProfileByName(ORCHESTRATOR_ACTION_PROFILE_MAP[action]);
}

/**
 * Returns the complete set of `ACTIONS` constants required to satisfy the
 * profile associated with the given orchestrator action.
 */
export function getRequiredActionsForOrchestratorAction(
  action: OrchestratorAction,
): ReadonlyArray<ActionName> {
  return getProfileForOrchestratorAction(action).actions;
}

// ---------------------------------------------------------------------------
// Authorization helper
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `role` is authorized to execute the given
 * `orchestratorAction` under `policy`.
 *
 * A role satisfies an orchestrator action when it is allowed (via the policy)
 * to perform **every** ACTIONS constant in the required workflow profile.
 * Because profiles are cumulative and roles are hierarchical, a higher-tier
 * role always satisfies the requirements of a lower-tier profile.
 *
 * Returns `false` for a `null` role (unrecognized session → default-deny).
 */
export function isOrchestratorActionAuthorized(
  role: Role | null,
  orchestratorAction: OrchestratorAction,
  policy: AuthPolicy,
): boolean {
  const requiredActions = getRequiredActionsForOrchestratorAction(orchestratorAction);
  return requiredActions.every((action) => isAuthorized(role, action, policy));
}

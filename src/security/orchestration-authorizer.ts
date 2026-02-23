import { evaluate, type DenyReason } from "./auth-evaluator";
import { loadAuthPolicy } from "./policy-loader";
import type { AuthPolicy, Role } from "./policy";
import {
  ORCHESTRATOR_ACTION_PROFILE_MAP,
  type OrchestratorAction,
  getRequiredActionsForOrchestratorAction,
} from "./workflow-profiles";
import {
  resolveRole,
  type RoleResolutionConfig,
  type SessionContext,
} from "./role-resolver";

export type OrchestrationDenyReason =
  | DenyReason
  | "policy-load-failed"
  | "role-resolution-failed"
  | "evaluator-error"
  | "missing-action-mapping";

export type OrchestrationAuthorizationDecision =
  | {
      decision: "allow";
      action: OrchestratorAction;
      role: Role;
      policy: AuthPolicy;
    }
  | {
      decision: "deny";
      action: OrchestratorAction;
      role: Role | null;
      reason: OrchestrationDenyReason;
      message: string;
    };

export async function authorizeOrchestratorAction(input: {
  action: OrchestratorAction;
  settingsFilePath: string;
  session: SessionContext;
  roleConfig: RoleResolutionConfig;
  loadPolicy?: (settingsFilePath: string) => Promise<AuthPolicy>;
  resolveSessionRole?: (
    context: SessionContext,
    config: RoleResolutionConfig,
  ) => Role | null;
  getRequiredActions?: (action: OrchestratorAction) => ReadonlyArray<string>;
}): Promise<OrchestrationAuthorizationDecision> {
  let policy: AuthPolicy;
  try {
    policy = await (input.loadPolicy ?? loadAuthPolicy)(input.settingsFilePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      decision: "deny",
      action: input.action,
      role: null,
      reason: "policy-load-failed",
      message,
    };
  }

  let role: Role | null;
  try {
    role = (input.resolveSessionRole ?? resolveRole)(
      input.session,
      input.roleConfig,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      decision: "deny",
      action: input.action,
      role: null,
      reason: "role-resolution-failed",
      message,
    };
  }

  if (role === null) {
    return {
      decision: "deny",
      action: input.action,
      role,
      reason: "role-resolution-failed",
      message: "Role resolution produced no role for current session.",
    };
  }

  if (!(input.action in ORCHESTRATOR_ACTION_PROFILE_MAP)) {
    return {
      decision: "deny",
      action: input.action,
      role,
      reason: "missing-action-mapping",
      message: `No workflow profile mapping exists for orchestrator action '${input.action}'.`,
    };
  }

  try {
    const requiredActions = (
      input.getRequiredActions ?? getRequiredActionsForOrchestratorAction
    )(input.action);
    for (const requiredAction of requiredActions) {
      const evaluated = evaluate(role, requiredAction, policy);
      if (evaluated.decision === "deny") {
        return {
          decision: "deny",
          action: input.action,
          role,
          reason: evaluated.reason,
          message: `Authorization denied for '${input.action}' via required action '${requiredAction}' [reason: ${evaluated.reason}]`,
        };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      decision: "deny",
      action: input.action,
      role,
      reason: "evaluator-error",
      message,
    };
  }

  return {
    decision: "allow",
    action: input.action,
    role,
    policy,
  };
}

export class OrchestrationAuthorizationDeniedError extends Error {
  readonly action: OrchestratorAction;
  readonly role: Role | null;
  readonly reason: OrchestrationDenyReason;

  constructor(
    decision: Extract<OrchestrationAuthorizationDecision, { decision: "deny" }>,
  ) {
    super(
      `Orchestration authorization denied for '${decision.action}'` +
        (decision.role ? ` (role: ${decision.role})` : "") +
        ` [reason: ${decision.reason}]` +
        (decision.message ? `: ${decision.message}` : ""),
    );
    this.name = "OrchestrationAuthorizationDeniedError";
    this.action = decision.action;
    this.role = decision.role;
    this.reason = decision.reason;
  }
}

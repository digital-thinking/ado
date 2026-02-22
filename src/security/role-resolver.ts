/**
 * Role resolution pipeline for IxADO authorization.
 *
 * Determines a user's role from their session context (Telegram or CLI).
 *
 * Precedence rules:
 *   1. CLI sessions use the configured cliRole (defaults to "owner" for local access).
 *   2. Telegram sessions: the configured telegramOwnerId always maps to "owner"
 *      (highest precedence for Telegram).
 *   3. Additional Telegram users are looked up in the telegramRoles assignment list;
 *      the first matching entry wins.
 *   4. Unrecognized Telegram users resolve to null (no role → default-deny).
 *   5. Unknown/invalid role strings in config resolve to null (fail-secure).
 */

import { RoleSchema, type Role } from "./policy";

// ---------------------------------------------------------------------------
// Session context types
// ---------------------------------------------------------------------------

/** Context from a Telegram bot interaction. */
export type TelegramUserContext = {
  source: "telegram";
  /** Numeric Telegram user ID from ctx.from.id. */
  userId: number;
};

/** Context from a CLI adapter session (local or remote). */
export type CliSessionContext = {
  source: "cli";
};

/** Union of all supported session context types. */
export type SessionContext = TelegramUserContext | CliSessionContext;

// ---------------------------------------------------------------------------
// Role resolution configuration
// ---------------------------------------------------------------------------

/**
 * Role resolution configuration.
 * Typically sourced from the `authorization.roles` section of the settings file.
 */
export type RoleResolutionConfig = {
  /**
   * Telegram user ID of the owner (from telegram.ownerId in settings).
   * This user always receives the "owner" role — highest precedence for Telegram.
   */
  telegramOwnerId?: number;

  /**
   * Additional Telegram user→role assignments.
   * Role strings are validated at resolution time; unknown strings resolve to null.
   * The first matching entry wins; entries are evaluated in order.
   * The telegramOwnerId check runs before this list, so an entry here for the
   * owner's userId is effectively ignored.
   */
  telegramRoles?: Array<{ userId: number; role: string }>;

  /**
   * Role assigned to CLI sessions.
   * Defaults to "owner" when absent (local CLI sessions are fully trusted).
   * An unknown/invalid role string resolves to null (fail-secure).
   */
  cliRole?: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseRoleOrNull(raw: string): Role | null {
  const result = RoleSchema.safeParse(raw);
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------
// Role resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the role for the given session context.
 *
 * Returns `null` when:
 *   - A Telegram user is not recognized (not the owner and not in telegramRoles).
 *   - The config contains an unrecognized role string (unknown role).
 */
export function resolveRole(
  context: SessionContext,
  config: RoleResolutionConfig,
): Role | null {
  if (context.source === "cli") {
    if (config.cliRole === undefined) {
      // No cliRole configured → default to "owner" for trusted local access
      return "owner";
    }
    return parseRoleOrNull(config.cliRole);
  }

  // Telegram path
  const { userId } = context;

  // telegramOwnerId has highest precedence — always resolves to "owner"
  if (config.telegramOwnerId !== undefined && userId === config.telegramOwnerId) {
    return "owner";
  }

  // Search additional role assignments in order; first match wins
  for (const assignment of config.telegramRoles ?? []) {
    if (assignment.userId === userId) {
      return parseRoleOrNull(assignment.role);
    }
  }

  // Unrecognized Telegram user — no role assigned
  return null;
}

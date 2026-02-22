import { describe, expect, test } from "bun:test";

import { resolveRole, type RoleResolutionConfig, type SessionContext } from "./role-resolver";

describe("resolveRole", () => {
  // -------------------------------------------------------------------------
  // CLI session context
  // -------------------------------------------------------------------------

  describe("CLI session context", () => {
    test("returns 'owner' by default when no cliRole is configured", () => {
      const context: SessionContext = { source: "cli" };
      const config: RoleResolutionConfig = {};
      expect(resolveRole(context, config)).toBe("owner");
    });

    test("returns the configured cliRole", () => {
      const context: SessionContext = { source: "cli" };
      const config: RoleResolutionConfig = { cliRole: "admin" };
      expect(resolveRole(context, config)).toBe("admin");
    });

    test("returns null for an unknown cliRole string (fail-secure)", () => {
      const context: SessionContext = { source: "cli" };
      const config: RoleResolutionConfig = { cliRole: "superadmin" };
      expect(resolveRole(context, config)).toBeNull();
    });

    test("returns null for an empty cliRole string", () => {
      const context: SessionContext = { source: "cli" };
      const config = { cliRole: "" } as RoleResolutionConfig;
      expect(resolveRole(context, config)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Telegram session context — owner ID
  // -------------------------------------------------------------------------

  describe("Telegram owner ID", () => {
    test("returns 'owner' when userId matches telegramOwnerId", () => {
      const context: SessionContext = { source: "telegram", userId: 42 };
      const config: RoleResolutionConfig = { telegramOwnerId: 42 };
      expect(resolveRole(context, config)).toBe("owner");
    });

    test("does not match owner when userId differs", () => {
      const context: SessionContext = { source: "telegram", userId: 99 };
      const config: RoleResolutionConfig = { telegramOwnerId: 42 };
      expect(resolveRole(context, config)).toBeNull();
    });

    test("owner ID takes precedence over telegramRoles assignment for same userId", () => {
      const context: SessionContext = { source: "telegram", userId: 42 };
      const config: RoleResolutionConfig = {
        telegramOwnerId: 42,
        telegramRoles: [{ userId: 42, role: "viewer" }],
      };
      // telegramOwnerId check runs first — must return "owner", not "viewer"
      expect(resolveRole(context, config)).toBe("owner");
    });
  });

  // -------------------------------------------------------------------------
  // Telegram session context — role assignments
  // -------------------------------------------------------------------------

  describe("Telegram role assignments", () => {
    test("returns the assigned role for a recognized Telegram user", () => {
      const context: SessionContext = { source: "telegram", userId: 100 };
      const config: RoleResolutionConfig = {
        telegramRoles: [{ userId: 100, role: "admin" }],
      };
      expect(resolveRole(context, config)).toBe("admin");
    });

    test("returns 'viewer' role for a viewer-assigned user", () => {
      const context: SessionContext = { source: "telegram", userId: 200 };
      const config: RoleResolutionConfig = {
        telegramRoles: [{ userId: 200, role: "viewer" }],
      };
      expect(resolveRole(context, config)).toBe("viewer");
    });

    test("returns 'operator' role for an operator-assigned user", () => {
      const context: SessionContext = { source: "telegram", userId: 300 };
      const config: RoleResolutionConfig = {
        telegramRoles: [{ userId: 300, role: "operator" }],
      };
      expect(resolveRole(context, config)).toBe("operator");
    });

    test("first matching entry wins when multiple entries share the same userId", () => {
      const context: SessionContext = { source: "telegram", userId: 100 };
      const config: RoleResolutionConfig = {
        telegramRoles: [
          { userId: 100, role: "admin" },
          { userId: 100, role: "viewer" },
        ],
      };
      // First entry wins
      expect(resolveRole(context, config)).toBe("admin");
    });

    test("returns null for an unknown Telegram user (no matching assignment)", () => {
      const context: SessionContext = { source: "telegram", userId: 999 };
      const config: RoleResolutionConfig = {
        telegramOwnerId: 42,
        telegramRoles: [{ userId: 100, role: "admin" }],
      };
      expect(resolveRole(context, config)).toBeNull();
    });

    test("returns null when telegramRoles is empty", () => {
      const context: SessionContext = { source: "telegram", userId: 100 };
      const config: RoleResolutionConfig = {
        telegramRoles: [],
      };
      expect(resolveRole(context, config)).toBeNull();
    });

    test("returns null when no config is provided for a Telegram user", () => {
      const context: SessionContext = { source: "telegram", userId: 100 };
      const config: RoleResolutionConfig = {};
      expect(resolveRole(context, config)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Unknown/invalid role strings
  // -------------------------------------------------------------------------

  describe("unknown role handling", () => {
    test("returns null for an unrecognized role string in telegramRoles", () => {
      const context: SessionContext = { source: "telegram", userId: 100 };
      const config: RoleResolutionConfig = {
        telegramRoles: [{ userId: 100, role: "superadmin" }],
      };
      expect(resolveRole(context, config)).toBeNull();
    });

    test("returns null for empty role string in telegramRoles", () => {
      const context: SessionContext = { source: "telegram", userId: 100 };
      const config: RoleResolutionConfig = {
        telegramRoles: [{ userId: 100, role: "" }],
      };
      expect(resolveRole(context, config)).toBeNull();
    });

    test("returns null when the only matching entry has an invalid role (no fallback to next entry)", () => {
      const context: SessionContext = { source: "telegram", userId: 100 };
      const config: RoleResolutionConfig = {
        telegramRoles: [
          { userId: 100, role: "superadmin" }, // matches but invalid — stops here
          { userId: 200, role: "viewer" },     // different userId — not checked
        ],
      };
      // First match wins; invalid role resolves to null, no further search
      expect(resolveRole(context, config)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Precedence summary
  // -------------------------------------------------------------------------

  describe("role precedence", () => {
    test("CLI session is not affected by Telegram configuration", () => {
      const context: SessionContext = { source: "cli" };
      const config: RoleResolutionConfig = {
        telegramOwnerId: 42,
        telegramRoles: [{ userId: 0, role: "viewer" }],
        cliRole: "admin",
      };
      expect(resolveRole(context, config)).toBe("admin");
    });

    test("Telegram user is not affected by cliRole configuration", () => {
      const context: SessionContext = { source: "telegram", userId: 100 };
      const config: RoleResolutionConfig = {
        cliRole: "owner",
        telegramRoles: [{ userId: 100, role: "viewer" }],
      };
      expect(resolveRole(context, config)).toBe("viewer");
    });

    test("full precedence scenario: owner > telegramRoles for Telegram, cliRole for CLI", () => {
      const ownerCtx: SessionContext = { source: "telegram", userId: 1 };
      const adminCtx: SessionContext = { source: "telegram", userId: 2 };
      const viewerCtx: SessionContext = { source: "telegram", userId: 3 };
      const unknownCtx: SessionContext = { source: "telegram", userId: 999 };
      const cliCtx: SessionContext = { source: "cli" };

      const config: RoleResolutionConfig = {
        telegramOwnerId: 1,
        telegramRoles: [
          { userId: 2, role: "admin" },
          { userId: 3, role: "viewer" },
        ],
        cliRole: "operator",
      };

      expect(resolveRole(ownerCtx, config)).toBe("owner");
      expect(resolveRole(adminCtx, config)).toBe("admin");
      expect(resolveRole(viewerCtx, config)).toBe("viewer");
      expect(resolveRole(unknownCtx, config)).toBeNull();
      expect(resolveRole(cliCtx, config)).toBe("operator");
    });
  });
});

import type { ExceptionMetadata } from "./types";

export abstract class RecoverableError extends Error {
  abstract readonly category: ExceptionMetadata["category"];

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class DirtyWorktreeError extends RecoverableError {
  readonly category = "DIRTY_WORKTREE";
  constructor(message = "Git working tree is not clean.") {
    super(message);
  }
}

export class MissingCommitError extends RecoverableError {
  readonly category = "MISSING_COMMIT";
  constructor(
    message = "CI integration requires a commit before push/PR, but there are no local changes to commit.",
  ) {
    super(message);
  }
}

export class AgentFailureError extends RecoverableError {
  readonly category = "AGENT_FAILURE";
  constructor(message: string) {
    super(message);
  }
}

# IxADO Bugs (Reproduced on Current Version)

## 1) CLI startup fails without env overrides (`EACCES` in logging)

- Severity: High
- Repro:

1. In this repo, run `ixado status` with default env.
2. CLI exits before command handling with:
   - `EACCES: permission denied, open`
   - stack at `appendLogLine` / `initializeCliLogging`.

- Observed workaround:
  - Set `IXADO_CLI_LOG_FILE` and `IXADO_AUDIT_LOG_FILE` to writable paths (for example `/tmp/...`).
- Code references:
  - `/root/scm/ado/src/cli/logging.ts:25`
  - `/root/scm/ado/src/cli/logging.ts:36`
  - `/root/scm/ado/src/cli/index.ts:53`

## 2) `phase run` fails on fresh project because `.ixado/` is untracked and trips clean-tree gate

- Severity: High
- Repro:

1. Use CLI to create phase and task.
2. Run `ixado phase run auto 1`.
3. Loop reports `DIRTY_WORKTREE` before task execution; repo shows `?? .ixado/`.

- Impact:
  - Phase execution does not start cleanly unless `.ixado/` is ignored/committed.
- Code references:
  - Clean-tree check in loop: `/root/scm/ado/src/cli/index.ts:1325`
  - Git check implementation: `/root/scm/ado/src/vcs/git-manager.ts:67`

## 3) Recovery path uses forced bypass args for Codex adapter

- Severity: Critical in constrained/sandboxed environments
- Repro:

1. Trigger recovery path (for example after `DIRTY_WORKTREE`).
2. Recovery attempts call Codex with:
   - `codex exec resume --last --dangerously-bypass-approvals-and-sandbox -`
3. In restricted environments this fails immediately and recovery exhausts.

- Impact:
  - Exception recovery cannot execute where policy disallows bypass flags.
- Evidence:
  - Runtime error output from `phase run` includes the exact command above.
- Code references:
  - Required Codex args include bypass flag: `/root/scm/ado/src/adapters/codex-adapter.ts:9`
  - Recovery exception categories and flow: `/root/scm/ado/src/engine/exception-recovery.ts:31`

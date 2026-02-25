# BUGS

Last triaged: February 25, 2026

This file is intentionally split into:

1. Confirmed open bugs
2. Needs verification
3. Resolved/outdated reports

## 1) Confirmed open bugs

### B-002: Terminal phase status blocks rerun even after adding new TODO tasks

- Severity: Medium
- Status: Open (current behavior, likely design mismatch)
- Reproduced on: February 25, 2026
- Symptom:
  - Adding a new TODO task to a phase already in `DONE` still prevents `ixado phase run`.
  - Error indicates phase is terminal and cannot be re-executed.
- Why this matters:
  - Workflow-completion tasks (for example PR finalization) added late require creating a new phase, fragmenting audit flow.
- Current code pointers:
  - Terminal preflight gate: `/root/scm/ado/src/engine/phase-runner.ts:201`
  - Regression test enforcing this behavior: `/root/scm/ado/src/cli/p20-005-regression.test.ts:77`
- Evidence required:
  - Command transcript adding TODO task after `DONE` and failed `phase run`.

## 2) Needs verification (high risk, insufficient current artifacts)

### B-003: Task can be marked `DONE` without verifying required external side effects

- Severity: High
- Status: Needs verification
- Originally observed on: February 25, 2026
- Claim:
  - PR/push-required tasks were marked `DONE` even when remote side effect (PR created / branch pushed) did not happen.
- Why plausible:
  - Task result is set to `DONE` based on successful worker process return, not semantic verification of PR existence/push.
- Current code pointers:
  - DONE transition after worker returns: `/root/scm/ado/src/web/control-center-service.ts:1025`
- Missing evidence right now:
  - Referenced historical agent log files are not present in current workspace path.
- Required repro evidence:
  1. Task prompt explicitly requires PR creation or push.
  2. Agent output shows failure to push/create PR.
  3. Ixado state marks task `DONE`.
  4. `gh pr list` / `git ls-remote` proves side effect missing.

### B-004: Worker runtime GitHub network/auth mismatch vs host shell

- Severity: High
- Status: Needs verification
- Originally observed on: February 25, 2026
- Claim:
  - Worker context could not resolve/authenticate GitHub while same host shell could.
- Why plausible:
  - Adapter runtime options can differ from host environment policy.
- Current code pointers:
  - Codex sandbox bypass is opt-in: `/root/scm/ado/src/adapters/codex-adapter.ts:17`
  - Startup policy hint only validates command startup, not end-to-end GitHub capability: `/root/scm/ado/src/adapters/startup.ts:23`
- Required repro evidence:
  1. Same timestamp window: worker failure log + host success commands.
  2. Effective adapter settings (`bypassApprovalsAndSandbox`, env).
  3. Network resolution evidence in both contexts.

### B-005: Limited runtime observability for long-running tasks

- Severity: Low-Medium
- Status: Needs verification
- Originally observed on: February 25, 2026
- Claim:
  - Long silent windows make it unclear if tasks are progressing or stuck.
- Why plausible:
  - UI/CLI focuses mainly on lifecycle transitions and terminal logs.
- Required repro evidence:
  1. Timeline showing long `IN_PROGRESS` with no intermediate output.
  2. Corresponding backend agent process still alive.
  3. Final completion confirms no hard deadlock.

## 3) Resolved / outdated reports

### R-001: “`ixado phase run auto 0` is rejected”

- Status: Resolved/outdated
- Reason:
  - CLI accepts non-negative integers; `0` is valid and documented.
- Code pointers:
  - Validation allowing `>= 0`: `/root/scm/ado/src/cli/index.ts:740`

### R-002: “`phase run` ignores per-task assignee”

- Status: Resolved/outdated
- Reason:
  - Runner uses task assignee when task is not `UNASSIGNED`.
  - Recent logs show task-specific routing to `CLAUDE_CLI` and `GEMINI_CLI`.
- Code pointers:
  - Effective assignee logic: `/root/scm/ado/src/engine/phase-runner.ts:420`
  - Evidence sample: `/root/scm/test_ixado.log`

## 4) Campaign confounders (important context)

- A prior run was interrupted (`<turn_aborted>`), which can leave ambiguous runtime state for part of the timeline.
- Manual host-side PR creation happened after at least one failed Ixado PR attempt, so downstream CI is not purely attributable to Ixado.
- One push attempt was raced against commit creation in the campaign history.
- An intentionally failing commit was injected to exercise CI-fix flow.

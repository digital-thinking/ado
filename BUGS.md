# BUGS

## 1) Default tester profile causes guaranteed first-run CI_FIX on non-Node repos

- Severity: Medium
- Symptom:
  - Initial task can finish `DONE`, but tester fails immediately with npm ENOENT because repo has no `package.json`.
  - Ixado creates a CI_FIX task to add test scaffolding.
- Why this is problematic:
  - For plain static repos, default test command (`npm run test`) yields deterministic initial failure unless users preconfigure settings.
  - This adds avoidable recovery churn in first-run UX.
- Code pointers:
  - Default tester settings: `/root/scm/ado/src/cli/settings.ts:31`
  - Default schema values: `/root/scm/ado/src/types/index.ts:47`

## 2) `phase run` docs/usage mismatch for countdown argument `0`

- Severity: Low
- Reproduced on: February 24, 2026
- Symptom:
  - `ixado phase run auto 0` returns:
    - `Startup failed: Usage: ixado phase run [auto|manual] [countdownSeconds]`
- Why this is a bug:
  - Help text advertises optional `[countdownSeconds]`, but `0` (a valid "start immediately" value in many CLIs) is rejected with generic usage output.
  - This is either argument-validation behavior not documented or parser behavior inconsistent with CLI help.
- Minimal repro:
  1. Run `ixado phase run auto 0`
  2. Observe usage failure instead of immediate loop start.
- Evidence:
  - `/root/scm/test_ixado.log`

## 3) `phase run` ignores per-task assignee and always uses default coding CLI

- Severity: Medium
- Reproduced on: February 24, 2026
- Symptom:
  - Task list showed task-specific assignees:
    - Task #2 assigned `CLAUDE_CLI`
    - Task #3 assigned `GEMINI_CLI`
  - `ixado phase run auto` executed both with `CODEX_CLI`:
    - `Execution loop: starting task #2 ... with CODEX_CLI`
    - `Execution loop: starting task #3 ... with CODEX_CLI`
- Why this is a bug:
  - Task-level assignee metadata is visible and accepted by `task create`, but phase loop routing does not honor it.
  - This can hide adapter-specific regressions unless every task is started manually.
- Minimal repro:
  1. Create tasks with different assignees.
  2. Run `ixado phase run auto`.
  3. Compare task assignees to execution-loop assignee lines.
- Evidence:
  - `/root/scm/test_ixado.log`

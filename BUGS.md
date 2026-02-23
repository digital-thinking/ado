# BUGS

## 1) DIRTY_WORKTREE recovery can loop indefinitely

- Severity: High
- Reproduced on: February 23, 2026
- Symptom:
  - `ixado phase run auto 1` repeatedly prints:
    - `Recovery attempt 1/1 ... DIRTY_WORKTREE`
    - `Recovery fixed: ...`
    - `Execution loop: recovery succeeded ... retrying.`
  - Then it immediately re-enters the same `DIRTY_WORKTREE` recovery path again.
- Why this is a bug:
  - Recovery is declared "fixed" but the branching precondition never becomes true.
  - The loop can continue without progressing to execution completion.
- Minimal repro:

1. Create phase/task with ixado.
2. Run `ixado phase run auto 1`.
3. Observe repeated `DIRTY_WORKTREE` recovery cycles with no forward progress.

- Code pointers:
  - Branching retry loop: `/root/scm/ado/src/engine/phase-runner.ts:120`
  - Recovery returns success with no postcondition validation: `/root/scm/ado/src/engine/phase-runner.ts:533`

## 2) Recovery result is trusted without verifying claimed git actions

- Severity: High
- Symptom:
  - Recovery messages claim local commits were created.
  - Repo state contradicts this (`git status` still shows untracked files; `git log` does not show the claimed recovery commits).
- Why this is a bug:
  - The orchestrator accepts model-declared recovery success without validating the repository actually satisfies the required state.
  - This directly enables false-positive recovery and contributes to repeated retry loops.
- Minimal repro:

1. Trigger dirty worktree recovery in `phase run`.
2. After "Recovery fixed" message claiming commits, run:
   - `git status --short`
   - `git log --oneline -n 8`
3. Observe unchanged dirty state and missing claimed commits.

- Code pointers:
  - Recovery output parse/accept flow: `/root/scm/ado/src/engine/exception-recovery.ts:129`
  - No git-state verification after `status: "fixed"` before returning: `/root/scm/ado/src/engine/phase-runner.ts:596`

## 3) Default tester profile causes guaranteed first-run CI_FIX on non-Node repos

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

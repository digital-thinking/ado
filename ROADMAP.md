# IxADO Development Roadmap

This roadmap contains only forward-looking work from the current project state.
Done/completed history is tracked in `TASKS.md`.

## Guiding Scope

- Keep roadmap strategic and concise.
- Derive executable implementation backlog in `TASKS.md`.
- Track defects and evidence in `BUGS.md`.

## Major Item 1: Parallel Phase Execution via Worktrees (Remaining)

Goal: Allow multiple phases to run concurrently, each isolated in its own git worktree, without interfering with the main working tree or each other.

Foundation shipped in Phase 27 (worktree provisioning, per-phase locks, concurrent state guards). Remaining work:

- Expand `activePhaseId` to `activePhaseIds` (set) in project state, with CLI support to add/remove phases from the active set.
- Add `--phase <id>` flag to `ixado phase run` for targeting a specific phase from the active set.
- Add `ixado worktree list|prune` for operator visibility and orphan cleanup.
- Update web UI and Telegram to show status of all phases in `activePhaseIds`, not just a single active phase.

## Major Item 2: Rate-Limit Backoff & Phase Timeout

Goal: Make long-running and overnight phase executions resilient to transient adapter rate-limits without operator intervention, and prevent runaway phases from consuming resources indefinitely.

- Add `maxTaskRetries` (default: 3) to phase/global config: when a task fails with a rate-limit signal (detected from adapter output), it is re-queued and retried up to this limit before being moved to dead-letter.
- Add `phaseTimeoutMs` (default: 6 hours) to phase config: if the phase has not reached a terminal state within the timeout, it is halted and transitioned to a new `TIMED_OUT` status with a clear diagnostic message.
- Emit `task:rate_limit_retry` and `phase:timeout` events through the unified runtime contract so Web Control Center and Telegram surface them visibly.
- Expose both settings in the Web Control Center project settings panel and via `ixado config`.

## Major Item 3: Pluggable Completion Gates & VCS Provider Abstraction

Goal: Replace the hardwired "PR + green GitHub CI" completion path with a composable gate chain, and decouple VCS operations behind a provider interface so non-GitHub workflows (GitLab, Gitea, local-only) are first-class.

### VCS Provider Abstraction
- Extract a `VcsProvider` interface from `GitHubManager` covering: push branch, open PR, poll checks, mark ready, merge.
- Implement `GitHubProvider` (current behavior), a `LocalProvider` (push only, no PR), and a `NullProvider` (no remote ops — branch stays local).
- Configuration selects the active provider per project; existing `ciEnabled` flag becomes a shorthand for `provider: github`.

### Pluggable Gate Chain
- Replace the single `ciEnabled` boolean with an ordered `gates` array on the phase config. Gates execute in sequence; the phase only advances to `DONE` (or `READY_FOR_REVIEW`) when all gates pass.
- Built-in gate types:
  - `command` — run a shell command; pass if exit code is 0. Covers test suites, linters, build steps.
  - `coverage` — parse a coverage report file against a configurable `minPct` threshold (supports lcov, JSON, Cobertura).
  - `ai_eval` — send the git diff + a user-defined rubric to a configured adapter; pass if the adapter returns a configurable keyword (e.g. `APPROVED`). Dynamic convergence loop with configurable max retries.
  - `pr_ci` — current GitHub CI polling behavior, now as an opt-in gate rather than the only path.
- Each gate is independently retryable and emits typed events (`gate:start`, `gate:pass`, `gate:fail`, `gate:retry`) through the unified runtime contract.
- On gate failure, surface the failing gate name and output in Telegram notifications and the Web Control Center.

### UI & Configuration
- Expose gate chain editor in Web Control Center: add/remove/reorder gates, configure per gate, preview the effective chain before running.
- Show per-gate status live during phase execution (pending / running / passed / failed).
- Provide sensible migration: projects with `ciEnabled: true` automatically get the equivalent `[pr_ci]` gate chain; `ciEnabled: false` gets an empty chain (current `DONE` behavior preserved).

## Major Item 4: Race Mode — Multi-Try Task Execution with AI Judge

Goal: Allow a task to be executed N times in parallel isolated worktrees, with an AI judge selecting the best result, improving output quality on high-stakes or non-deterministic tasks.

- Add a `race: N` property on tasks (and a phase-level default) that spawns N identical worktree branches for the same task, each running independently.
- After all branches complete, a configurable judge adapter reads all outputs and emits `PICK <N>` to select the winning branch; the winner is merged/cherry-picked and the losers are pruned.
- Expose race configuration in the Web Control Center: set `race` count per task or as a phase default, view per-branch status live, and see the judge's reasoning before the pick is applied.
- Emit structured race events (`race:start`, `race:branch`, `race:judge`, `race:pick`) through the unified runtime event contract so Telegram and the UI reflect branch progress in real time.
- Reuse the existing `.ixado/worktrees/` infrastructure from Parallel Phase Execution; race branches live under `.ixado/worktrees/<phase-id>/race-<task-id>-<n>/`.
- Fall back gracefully to single-try execution when `race` is unset or N=1, preserving all existing behavior.

## Major Item 5: Phase Execution DAG

Goal: Give operators a clear visual record of what actually happened during a phase — task order, retries, gate results, race branches, and deliberation passes — as a directed acyclic graph in the Web Control Center.

- Record a structured execution trace per phase: each node represents a discrete execution unit (task run, recovery attempt, race branch, gate evaluation, deliberation pass) with start time, duration, status, and adapter used.
- Persist the trace alongside existing phase state so it survives restarts and is viewable after phase completion.
- Render the trace as an interactive DAG in the Web Control Center phase detail view: nodes are color-coded by outcome (pass/fail/retry/skipped), edges show dependency and sequencing, and clicking a node opens its log output.
- Highlight the critical path (longest chain of dependent nodes) to make bottlenecks immediately visible.
- Include gate outcomes (from Major Item 3) and race branch selection (from Major Item 4) as first-class node types in the DAG.

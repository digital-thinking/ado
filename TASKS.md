# IxADO Task Plan

Status markers:

- `[ ]` TODO
- `[x]` Done

## Completed Phases (Compact Summary)

- **Phase 1**: Foundation & state management completed. PR opened.
- **Phase 2**: Git and subprocess orchestration completed. PR opened.
- **Phase 3**: Telegram command center completed. PR opened.
- **Phase 4**: Vendor adapters and usage tracker completed. PR opened.
- **Phase 5**: CI execution loop and validation flow completed. PR opened.
- **Phase 6**: Web interface baseline completed. PR opened.
- **Phase 7**: Packaging and distribution polish completed. PR opened.
- **Phase 8**: Multi-project management completed. PR opened.
- **Phase 10**: Authorization and security hardening completed. PR #11.
- **Phase 11**: Command gating, privileged git actions, auditability completed. PR #12.
- **Phase 12**: Project-tabs/global-settings web refactor completed. PR #13.
- **Phase 13**: Post-release CLI bugfixes completed. PR #14.
- **Phase 14**: AI-assisted exception recovery completed. PR #15.
- **Phase 15**: Architecture refactor and debt reduction completed. PR #16.
- **Phase 16**: Runtime stability refactor completed. PR #17.
- **Phase 17**: Recovery/state verification/tester-default bug fixes completed. PR #18.
- **Phase 18**: CLI adapter execution reliability fixes completed. PR #19.
- **Phase 19**: Open bug backlog fixes completed. PR #20.
- **Phase 20**: Execution reliability hardening completed. PR #21.
- **Phase 21**: Config and UX consistency completed. PR #22.
- **Phase 22**: Adapter health and observability completed. PR #23.
- **Phase 23**: Integrations expansion completed. PR #24.
- **Phase 24**: Extensibility hooks completed. PR #25.

## Active / Open Phases

### Phase 25: Execution Correctness & Runtime Transparency (from BUGS.md)

- [x] `P25-001` Allow deterministic continuation after terminal phase status when actionable tasks are added post-completion: define explicit gate semantics (e.g., terminal + pending TODO/CI_FIX => resumable transition) and preserve fail-fast behavior for truly closed phases. Deps: `P24-005`.
- [x] `P25-002` Add task completion verification contracts for side-effect-bound tasks (PR creation, remote push, CI-triggered updates): require explicit verification probes before persisting `DONE`, and persist structured failure context when side effects are missing. Deps: `P24-005`.
- [x] `P25-003` Add runtime capability preflight for GitHub-bound operations (network/auth/tooling) in worker execution context and fail fast with actionable diagnostics when capability mismatches are detected. Deps: `P25-002`.
- [x] `P25-004` Improve long-running task observability with heartbeat/idle diagnostics surfaced consistently in CLI and web agent views to distinguish slow progress from stalls. Deps: `P24-005`.
- [x] `P25-005` Add regression/integration tests for Phase 25: terminal-phase continuation semantics, side-effect verification gating, capability preflight failures, and runtime heartbeat telemetry behavior. Deps: `P25-001`, `P25-002`, `P25-003`, `P25-004`.
- [x] `P25-007` Add web UI execution controls for auto-mode start/stop/status via backend endpoints, including clean stop/reset to the last completed task, plus regression tests. Deps: `P24-005`.
- [x] `P25-008` Enforce single active execution per project across CLI `phase run` and web auto execution using a shared run lock with stale-lock recovery and fail-fast duplicate-start rejection. Deps: `P25-007`.
- [x] `P25-006` Create PR Task: open Phase 25 PR after coding tasks are done. Deps: `P25-005`.

### Phase 26: State Consistency & Orchestration Hardening (from validated BUGS.md points)

- [x] `P26-001` Split/clarify phase failure semantics so local tester failures and remote CI failures are represented distinctly (status or typed `failureKind`), with operator guidance tied to failure kind. Deps: `P25-006`.
- [x] `P26-002` Add CI_FIX cascade guardrails: enforce a configurable depth/count cap for fix-task fan-out and fail fast with actionable messaging when exceeded. Deps: `P26-001`.
- [x] `P26-003` Reconcile stale `IN_PROGRESS` tasks across all phases (not only active phase) during startup recovery. Deps: `P26-001`.
- [x] `P26-004` Wire agent restart/kill flows to task-state reconciliation hooks so UI-initiated lifecycle actions cannot leave tasks permanently inconsistent. Deps: `P26-003`.
- [x] `P26-005` Add cross-store consistency reconciliation between global agent registry and project task state at startup (stale RUNNING agents vs task terminal states). Deps: `P26-003`.
- [x] `P26-006` Make JSON persistence atomic for critical state files (temp-file + rename) and reduce agent-registry write amplification with batched flush strategy. Deps: `P26-005`.
- [x] `P26-007` Replace hardcoded adapter-ID parsing in persisted-agent deserialization with schema-driven parsing (`CLIAdapterIdSchema`) to keep adapter support DRY. Deps: `P26-006`.
- [x] `P26-008` Replace silent active-phase fallback (`phases[0]`) with explicit deterministic behavior (strict error or explicit warning + policy) for multi-phase safety. Deps: `P26-001`.
- [x] `P26-009` Add explicit truncation markers for stored `resultContext`/`errorLogs` so operators can see when diagnostic text was shortened. Deps: `P26-006`.
- [x] `P26-010` Validate branch base preconditions before creating a phase branch from `HEAD` to avoid accidental branch-from-branch drift. Deps: `P26-008`.
- [x] `P26-011` Refactor `ControlCenterService` constructor to a typed options object (remove positional optional-argument anti-pattern) and update call sites. Deps: `P26-006`.
- [x] `P26-012` Add regression/integration tests for Phase 26: failure-kind transitions, CI_FIX cap behavior, all-phase reconciliation, restart consistency hooks, atomic persistence, adapter-ID schema parsing, active-phase selection policy, truncation markers, and branch-base verification. Deps: `P26-002`, `P26-004`, `P26-007`, `P26-008`, `P26-009`, `P26-010`, `P26-011`.
- [x] `P26-014` Cap agent lists in web UI to the most recent 5 records for both Global Agents and per-project Running Agents using deterministic recency ordering. Deps: `P26-005`.
- [x] `P26-015` Filter agent log stream content to hide file-interaction chatter and show only reasoning/thinking progress plus terminal outcome context. Deps: `P26-009`.
- [x] `P26-016` Fix GitHub capability preflight false negatives and environment mismatch diagnostics: correct network probe semantics, capture effective runtime identity/env fingerprints, and report actionable auth/runtime differences. Deps: `P26-001`.
- [x] `P26-017` Add regression/integration tests for new Phase 26 agent UX + preflight tasks (top-5 agent truncation, reasoning-only log stream filter, and GitHub preflight parity diagnostics). Deps: `P26-014`, `P26-015`, `P26-016`.
- [x] `P26-013` Create PR Task: open Phase 26 PR after coding tasks are done. Deps: `P26-012`, `P26-017`.

### Phase 27: Parallel Phase Execution via Worktrees

- [ ] `P27-001` Add optional `worktreePath: string` field to `PhaseSchema` in `src/types/index.ts`. When set, the phase runner uses this path as its working directory instead of `projectRootDir`. Null/absent means legacy single-tree behaviour.
- [ ] `P27-002` Add `worktrees` config section to `CliSettingsSchema`: `enabled: boolean` (default `false`), `baseDir: string` (default `.ixado/worktrees`). Deps: `P27-001`.
- [ ] `P27-003` Implement `WorktreeManager` in `src/vcs/`: `provision(phaseId, branchName, fromRef)` → calls `GitManager.createWorktree` and returns the worktree path; `teardown(phaseId)` → calls `GitManager.removeWorktree`; `listActive()` → reads `.git/worktrees`; `pruneOrphaned()` → removes worktree dirs whose phase is terminal/missing. Deps: `P27-002`.
- [ ] `P27-004` Wire `WorktreeManager` into `PhaseRunner.prepareBranch()`: when `worktrees.enabled`, provision the worktree before branch checkout and store `worktreePath` on the phase; use `worktreePath` as `cwd` for all subsequent task executions, git ops, and tester runs. Teardown on phase completion or unrecoverable failure. Deps: `P27-003`.
- [ ] `P27-005` Make `ExecutionRunLock` per-phase: change the lock file path from `execution-run.lock.json` to `execution-run-<phaseId>.lock.json` so multiple phase runners can hold independent locks. Update all callsites in CLI and web. Deps: `P27-001`.
- [ ] `P27-006` Guard `StateEngine` against concurrent writers: add a per-file async mutex (read-modify-write with retry on conflict) so parallel `PhaseRunner` processes writing different phase records do not corrupt shared state. Deps: `P27-005`.
- [ ] `P27-007` Replace `activePhaseId: string` with `activePhaseIds: string[]` in `ProjectStateSchema`; keep backward-compat read of legacy single-id field on load. Update `resolveActivePhaseStrict` to resolve a target phase by ID from the set. Update `ixado phase active` CLI to add/remove IDs from the set. Deps: `P27-006`.
- [ ] `P27-008` Update `ixado phase run` CLI to accept `--phase <id>` flag targeting a specific phase from `activePhaseIds`, enabling operators to launch parallel runners for different phases in separate terminals. Deps: `P27-007`.
- [ ] `P27-009` Add `ixado worktree list` (show all active worktrees with phase/branch/status) and `ixado worktree prune` (remove orphaned worktrees for terminal/missing phases) CLI subcommands. Deps: `P27-003`.
- [ ] `P27-010` Update web UI and Telegram to show status of all phases in `activePhaseIds`, not just a single active phase — phase list view, runtime events, and notifications. Deps: `P27-007`.
- [ ] `P27-011` Add regression/integration tests for Phase 27: worktree lifecycle (provision, teardown, prune), per-phase lock independence, concurrent state writes without corruption, `activePhaseIds` set operations, and `--phase` flag routing. Deps: `P27-001`..`P27-010`.
- [ ] `P27-012` Create PR Task: open Phase 27 PR after coding tasks are done. Deps: `P27-011`.

### Phase 28: Semantic Task Routing

- [x] `P28-001` Add optional `taskType` field (enum: `implementation | code-review | test-writing | security-audit | documentation`) to `TaskSchema` in `src/types/index.ts`. Default absent (unclassified). Update Zod schema and derived types.
- [x] `P28-002` Add `adapterAffinities` config to `CliAgentSettingsSchema`: map of `taskType → CLIAdapterId`. Validate that referenced adapters exist in the enabled set. Deps: `P28-001`.
- [x] `P28-003` Implement a local heuristic classifier in `src/engine/` that inspects task `title` + `description` keywords to infer `taskType` with zero API calls (e.g. "test" → `test-writing`, "review" → `code-review`, "security" → `security-audit`, "doc" → `documentation`). Deps: `P28-001`.
- [x] `P28-004` Wire affinity routing into `PhaseRunner`: when a task has a `taskType` and a matching affinity mapping exists, use the mapped adapter instead of `activeAssignee`; fall back to `activeAssignee` with a logged reason when no mapping found. Store `resolvedAssignee` and `routingReason` (`"affinity" | "fallback"`) in task metadata. Deps: `P28-002`, `P28-003`.
- [x] `P28-005` Auto-classify tasks at creation time using the heuristic classifier; allow manual override via `task create --type <taskType>`. Deps: `P28-003`.
- [x] `P28-006` Add regression/integration tests for Phase 28: `taskType` schema validation, heuristic classifier keyword coverage, affinity routing in phase runner, fallback behavior, and task-creation type inference. Deps: `P28-004`, `P28-005`.
- [x] `P28-007` Create PR Task: open Phase 28 PR after coding tasks are done. Deps: `P28-006`.

### Phase 29: Reliability & Traceability Enhancements

- [x] `P29-001` Add `DEAD_LETTER` to `TaskStatusSchema` in `src/types/index.ts`. Transition tasks from `FAILED` → `DEAD_LETTER` in `PhaseRunner` when recovery attempts are exhausted and result is `unfixable`. Surface dead-letter tasks in CLI and web with distinct treatment and remediation hint.
- [x] `P29-002` Implement `AdapterCircuitBreaker` in `src/adapters/`: tracks consecutive failures per adapter, opens circuit after a configurable `failureThreshold`, auto-closes after a `cooldownMs` window. Expose as a shared singleton per phase-runner lifetime.
- [x] `P29-003` Add `circuitBreaker` sub-config to `CliAgentSettingsItemSchema`: `failureThreshold: number` (default 3), `cooldownMs: number` (default 300000). Deps: `P29-002`.
- [x] `P29-004` Wire circuit breaker into `PhaseRunner`: before dispatching to an adapter, check its circuit state; if open, route to the next enabled adapter (ordered fallback chain); emit a `RuntimeEvent` when a breaker opens or closes. Deps: `P29-002`, `P29-003`.
- [x] `P29-005` Inject git trailers into IxADO-orchestrated commits via `GitManager`: `Originated-By: <phase-id>/<task-id>` and `Executed-By: <adapter-id>`. Identify all commit call sites in `src/vcs/` and `src/engine/` and thread the metadata through.
- [ ] `P29-006` Add regression/integration tests for Phase 29: dead-letter transition and CLI/web surfacing, circuit breaker open/close/cooldown cycles, fallback routing, and git trailer presence in commit messages. Deps: `P29-001`..`P29-005`.
- [ ] `P29-007` Create PR Task: open Phase 29 PR after coding tasks are done. Deps: `P29-006`.

### Phase 30: Deliberation Mode

- [ ] `P30-001` Add optional `deliberate: boolean` flag to `TaskSchema`. When `true`, the task requires a council review pass before implementation.
- [ ] `P30-002` Add `deliberation` section to `ExecutionLoopSettingsSchema`: `reviewerAdapter: CLIAdapterId`, `maxRefinePasses: number` (default 1). Validate reviewer adapter is enabled. Deps: `P30-001`.
- [ ] `P30-003` Implement `runDeliberationPass` in `src/engine/`: propose (implementer adapter) → critique (reviewer adapter) → refine (implementer) loop producing a structured deliberation summary. Deps: `P30-002`.
- [ ] `P30-004` Wire deliberation into `PhaseRunner`: when a task has `deliberate: true`, run the deliberation pass first, then hand the refined prompt to the standard execution path. Store the deliberation summary in task `resultContext`. Deps: `P30-003`.
- [ ] `P30-005` Surface deliberation summary in PR body (collapsible section) and Telegram notification for the task. Deps: `P30-004`.
- [ ] `P30-006` Add regression/integration tests for Phase 30: deliberation pass execution, refined-prompt handoff to execution, summary in PR body and Telegram, graceful fallback when reviewer adapter is unavailable. Deps: `P30-001`..`P30-005`.
- [ ] `P30-007` Create PR Task: open Phase 30 PR after coding tasks are done. Deps: `P30-006`.

### Phase 31: Autonomous Task Discovery

- [ ] `P31-001` Implement a TODO/FIXME scanner in `src/engine/`: recursively scans project files respecting configurable include/exclude patterns, extracts comment text + file/line context, computes a priority score (recency, frequency, tag weight).
- [ ] `P31-002` Integrate with GitHub issues via `src/vcs/github-manager.ts`: fetch open issues, parse title/body into ranked task candidates and merge with TODO scan results. Deps: `P31-001`.
- [ ] `P31-003` Add `ixado discover` CLI command: `--dry-run` flag prints ranked candidates without queuing; `--queue` flag adds approved candidates to the active phase as TODO tasks. Deps: `P31-001`, `P31-002`.
- [ ] `P31-004` Add `discovery` config section to `CliSettingsSchema`: `includePatterns`, `excludePatterns`, `priorityWeights` (`recency`, `frequency`, `tags`), `maxCandidates`. Deps: `P31-001`.
- [ ] `P31-005` Add regression/integration tests for Phase 31: scanner extraction, issue mapping, priority ranking, dry-run output correctness, task queuing, and config validation. Deps: `P31-001`..`P31-004`.
- [ ] `P31-006` Create PR Task: open Phase 31 PR after coding tasks are done. Deps: `P31-005`.

## Deferred / Later

### Phase 9: Shell Integration (deferred for later)

- [ ] `P9-001` Implement `ixado completion` command to generate shell completion scripts (Bash, Zsh, Fish). Deps: `P8-007`.
- [ ] `P9-002` Add installation instructions for shell completion to `README.md`. Deps: `P9-001`.
- [ ] `P9-003` Create PR Task: open Phase 9 PR after coding tasks are done. Deps: `P9-002`.

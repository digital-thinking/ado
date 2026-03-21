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
- **Phase 9**: Shell integration (completion scripts). PR #34.
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
- **Phase 25**: Execution correctness & runtime transparency completed. PR #26.
- **Phase 26**: State consistency & orchestration hardening completed. PR #27.
- **Phase 28**: Semantic task routing completed. PR #30.
- **Phase 29**: Reliability & traceability enhancements (dead-letter, circuit breaker, git trailers) completed. PR #30.
- **Phase 30**: Deliberation mode (council review passes) completed. PR #31.
- **Phase 31**: Autonomous task discovery (TODO/FIXME scanner, issue integration) completed. PR #32.

## Active / Open Phases

### Phase 27: Parallel Phase Execution via Worktrees (Remaining)

Foundation shipped in PR #33 (worktree provisioning, per-phase locks, concurrent state guards).

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

- [x] `P27-001` Add optional `worktreePath: string` field to `PhaseSchema` in `src/types/index.ts`. When set, the phase runner uses this path as its working directory instead of `projectRootDir`. Null/absent means legacy single-tree behaviour.
- [x] `P27-002` Add `worktrees` config section to `CliSettingsSchema`: `enabled: boolean` (default `false`), `baseDir: string` (default `.ixado/worktrees`). Deps: `P27-001`.
- [x] `P27-003` Implement `WorktreeManager` in `src/vcs/`: `provision(phaseId, branchName, fromRef)` → calls `GitManager.createWorktree` and returns the worktree path; `teardown(phaseId)` → calls `GitManager.removeWorktree`; `listActive()` → reads `.git/worktrees`; `pruneOrphaned()` → removes worktree dirs whose phase is terminal/missing. Deps: `P27-002`.
- [x] `P27-004` Wire `WorktreeManager` into `PhaseRunner.prepareBranch()`: when `worktrees.enabled`, provision the worktree before branch checkout and store `worktreePath` on the phase; use `worktreePath` as `cwd` for all subsequent task executions, git ops, and tester runs. Teardown on phase completion or unrecoverable failure. Deps: `P27-003`.
- [x] `P27-005` Make `ExecutionRunLock` per-phase: change the lock file path from `execution-run.lock.json` to `execution-run-<phaseId>.lock.json` so multiple phase runners can hold independent locks. Update all callsites in CLI and web. Deps: `P27-001`.
- [x] `P27-006` Guard `StateEngine` against concurrent writers: add a per-file async mutex (read-modify-write with retry on conflict) so parallel `PhaseRunner` processes writing different phase records do not corrupt shared state. Deps: `P27-005`.
- [x] `P27-007` Replace `activePhaseId: string` with `activePhaseIds: string[]` in `ProjectStateSchema`; keep backward-compat read of legacy single-id field on load. Update `resolveActivePhaseStrict` to resolve a target phase by ID from the set. Update `ixado phase active` CLI to add/remove IDs from the set. Deps: `P27-006`.
- [x] `P27-008` Update `ixado phase run` CLI to accept `--phase <id>` flag targeting a specific phase from `activePhaseIds`, enabling operators to launch parallel runners for different phases in separate terminals. Deps: `P27-007`.
- [x] `P27-009` Add `ixado worktree list` (show all active worktrees with phase/branch/status) and `ixado worktree prune` (remove orphaned worktrees for terminal/missing phases) CLI subcommands. Deps: `P27-003`.
- [x] `P27-010` Update web UI and Telegram to show status of all phases in `activePhaseIds`, not just a single active phase — phase list view, runtime events, and notifications. Deps: `P27-007`.
- [x] `P27-011` Add regression/integration tests for Phase 27: worktree lifecycle (provision, teardown, prune), per-phase lock independence, concurrent state writes without corruption, `activePhaseIds` set operations, and `--phase` flag routing. Deps: `P27-001`..`P27-010`.
- [ ] `P27-012` ~~Create PR Task~~ Obsolete — orchestrator owns PR creation deterministically via `ci-integration.ts`. Deps: `P27-011`.

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
- [x] `P29-006` Add regression/integration tests for Phase 29: dead-letter transition and CLI/web surfacing, circuit breaker open/close/cooldown cycles, fallback routing, and git trailer presence in commit messages. Deps: `P29-001`..`P29-005`.
- [x] `P29-007` Create PR Task: open Phase 29 PR after coding tasks are done. Deps: `P29-006`.

### Phase 30: Deliberation Mode

- [ ] `P30-001` Add optional `deliberate: boolean` flag to `TaskSchema`. When `true`, the task requires a council review pass before implementation.
- [x] `P30-002` Add `deliberation` section to `ExecutionLoopSettingsSchema`: `reviewerAdapter: CLIAdapterId`, `maxRefinePasses: number` (default 1). Validate reviewer adapter is enabled. Deps: `P30-001`.
- [x] `P30-003` Implement `runDeliberationPass` in `src/engine/`: propose (implementer adapter) → critique (reviewer adapter) → refine (implementer) loop producing a structured deliberation summary. Deps: `P30-002`.
- [x] `P30-004` Wire deliberation into `PhaseRunner`: when a task has `deliberate: true`, run the deliberation pass first, then hand the refined prompt to the standard execution path. Store the deliberation summary in task `resultContext`. Deps: `P30-003`.
- [x] `P30-005` Surface deliberation summary in PR body (collapsible section) and Telegram notification for the task. Deps: `P30-004`.
- [x] `P30-006` Add regression/integration tests for Phase 30: deliberation pass execution, refined-prompt handoff to execution, summary in PR body and Telegram, graceful fallback when reviewer adapter is unavailable. Deps: `P30-001`..`P30-005`.
- [ ] `P30-007` ~~Create PR Task~~ Obsolete — orchestrator owns PR creation. Deps: `P30-006`.

### Phase 31: Autonomous Task Discovery

- [x] `P31-001` Implement a TODO/FIXME scanner in `src/engine/`: recursively scans project files respecting configurable include/exclude patterns, extracts comment text + file/line context, computes a priority score (recency, frequency, tag weight).
- [x] `P31-002` Integrate with GitHub issues via `src/vcs/github-manager.ts`: fetch open issues, parse title/body into ranked task candidates and merge with TODO scan results. Deps: `P31-001`.
- [x] `P31-003` Add `ixado discover` CLI command: `--dry-run` flag prints ranked candidates without queuing; `--queue` flag adds approved candidates to the active phase as TODO tasks. Deps: `P31-001`, `P31-002`.
- [x] `P31-004` Add `discovery` config section to `CliSettingsSchema`: `includePatterns`, `excludePatterns`, `priorityWeights` (`recency`, `frequency`, `tags`), `maxCandidates`. Deps: `P31-001`.
- [x] `P31-005` Add regression/integration tests for Phase 31: scanner extraction, issue mapping, priority ranking, dry-run output correctness, task queuing, and config validation. Deps: `P31-001`..`P31-004`.
- [ ] `P31-006` ~~Create PR Task~~ Obsolete — orchestrator owns PR creation. Deps: `P31-005`.

### Phase 32: Telegram Natural Language Assistant

- [ ] `P32-001` Define `LLMChatProvider` interface in `src/bot/`: `chat(userMessage, context) → ChatResponse` with optional structured `actions[]`.
- [ ] `P32-002` Implement `CodexCLIChatProvider` satisfying `LLMChatProvider`: structured system prompt from `ChatContext`, multi-turn history, action-marker parsing. Deps: `P32-001`.
- [ ] `P32-003` Add `llmChat` config section to `CliSettingsSchema`: `enabled`, `adapterId`, `maxHistoryMessages`. Deps: `P32-001`.
- [ ] `P32-004` Implement `ChatActionExecutor` in `src/bot/`: maps `ChatResponse.actions` to engine operations. Deps: `P32-001`.
- [ ] `P32-005` Wire NL message handler into `createTelegramRuntime`: owner-gated non-command text → `ChatContext` → `LLMChatProvider.chat()` → execute actions → reply. Deps: `P32-002`, `P32-003`, `P32-004`.
- [ ] `P32-006` Add per-bot-session in-memory message history ring buffer (capped at `maxHistoryMessages`). Deps: `P32-005`.
- [ ] `P32-007` Update Telegram startup greeting and add `/help` listing both slash commands and NL capabilities. Deps: `P32-005`.
- [ ] `P32-008` Add regression/integration tests for Phase 32. Deps: `P32-001`..`P32-007`.
- [ ] `P32-009` Create PR Task. Deps: `P32-008`.

### Phase 33: Rate-Limit Backoff & Phase Timeout

- [x] `P33-001` Add `maxTaskRetries: number` (default 3) to `ExecutionLoopSettingsSchema` and expose via `ixado config`. Deps: none.
- [x] `P33-002` Add rate-limit signal detection to adapter output parsing: scan stderr/stdout for common rate-limit patterns (HTTP 429, "rate limit", "too many requests", "retry after") and tag the failure as `rate_limited`. Deps: none.
- [x] `P33-003` Wire retry logic into `PhaseRunner`: when a task fails with `rate_limited`, re-queue it with an incremented retry counter and exponential backoff delay (starting 30s, capped at 5min); move to dead-letter after `maxTaskRetries` exhausted. Deps: `P33-001`, `P33-002`.
- [x] `P33-004` Add `phaseTimeoutMs: number` (default 21600000 / 6 hours) to phase config in `CliSettingsSchema`. Deps: none.
- [x] `P33-005` Add `TIMED_OUT` to `PhaseStatusSchema`. Implement phase timeout watchdog in `PhaseRunner`: start a timer on phase execution begin; on expiry, halt execution and transition to `TIMED_OUT` with diagnostic message. Deps: `P33-004`.
- [x] `P33-006` Emit `task:rate_limit_retry` and `phase:timeout` events through the unified runtime event contract; surface in Web Control Center and Telegram. Deps: `P33-003`, `P33-005`.
- [x] `P33-007` Expose `maxTaskRetries` and `phaseTimeoutMs` in Web Control Center project settings panel. Deps: `P33-001`, `P33-004`.
- [x] `P33-008` Add regression/integration tests: rate-limit detection across adapter outputs, retry counter and backoff timing, dead-letter after exhaustion, phase timeout transition, event emission. Deps: `P33-003`, `P33-005`, `P33-006`.
- [ ] `P33-009` ~~Create PR Task~~ Obsolete — orchestrator owns PR creation. Deps: `P33-008`.

### Phase 34: Pluggable Completion Gates & VCS Provider Abstraction

- [x] `P34-001` Extract `VcsProvider` interface from `GitHubManager` in `src/vcs/`: `pushBranch`, `openPr`, `pollChecks`, `markReady`, `mergePr`. Deps: none.
- [x] `P34-002` Implement `GitHubProvider` wrapping existing `GitHubManager` logic behind the `VcsProvider` interface (preserves all current behavior). Deps: `P34-001`.
<<<<<<< HEAD
<<<<<<< HEAD
- [x] `P34-003` Implement `LocalProvider` (push to remote only, no PR operations) and `NullProvider` (no remote ops — branch stays local). Deps: `P34-001`.
- [x] `P34-003a` Remove per-task `REMOTE_PUSH` and `PR_CREATION` side-effect contracts from `verifyTaskCompletionSideEffects`. These are orchestrator responsibilities (push/PR happen deterministically in `ci-integration.ts` after execution loop), not agent task side-effects. Updated tests to use `CI_TRIGGERED_UPDATE` contracts. Deps: `P34-003`.
- [x] `P34-004` Add `vcsProvider` config to project settings (`github | local | null`, default `null`). Migrate `ciEnabled: true` → `vcsProvider: github` via Zod transform. Wire `VcsProvider` into `runCiIntegration` (replaces direct `GitManager`/`GitHubManager`/`PrivilegedGitActions` instantiation). Provider-aware: `NullProvider` skips push/PR, `LocalProvider` pushes but skips PR → DONE, `GitHubProvider` does full push/PR/CI flow. Added `createVcsProvider` factory. Deps: `P34-002`, `P34-003a`.
- [x] `P34-005` Define `Gate` interface (`evaluate(context: GateContext): Promise<GateResult>`) and `GateChain` runner (`runGateChain`) that executes gates in sequence, stops at first failure, supports `onGateStart`/`onGateResult` callbacks. `GateContext` carries phase, VCS provider type, branch info, PR details. `GateResult` includes `passed`, `diagnostics`, `retryable`. 8 tests. Deps: none.
- [x] `P34-006` Implement `CommandGate`: run a configurable shell command; pass if exit code is 0; capture stdout/stderr for diagnostics. Retryable on exceptions. 8 tests. Deps: `P34-005`.
- [x] `P34-007` Implement `CoverageGate`: parse lcov/JSON/Cobertura coverage reports, enforce configurable `minPct` threshold, auto-detect format. 9 tests. Deps: `P34-005`.
- [x] `P34-008` Implement `AiEvalGate`: send `git diff` + user-defined rubric to adapter CLI, scan response for configurable pass/fail keywords (case-insensitive), retry up to `maxRetries` on fail verdict. 12 tests. Deps: `P34-005`.
- [x] `P34-009` Implement `PrCiGate`: polls CI via `VcsProvider.pollChecks()`, configurable interval/timeout/confirmations, includes check details + URLs in diagnostics. 8 tests. Deps: `P34-005`, `P34-004`.
- [x] `P34-010` Replace `ciEnabled` code path in `PhaseRunner` with `GateChain` execution. Auto-migrate legacy config: `ciEnabled: true` → `gates: [pr_ci]`, `ciEnabled: false` → `gates: []`. Added `GateConfigSchema` discriminated union, `gates` field to `ExecutionLoopSettingsSchema` with Zod transforms for backward compat, `createGatesFromConfig` factory, `runPostIntegrationGateChain` in PhaseRunner. All 1134 tests pass. Deps: `P34-006`..`P34-009`.
- [x] `P34-011` Emit typed gate events (`gate.activity` with stages `start`, `pass`, `fail`, `retry`) through the unified runtime event contract. Added `GateActivityEventSchema` to `runtime-events.ts`, CLI/Telegram formatters, notification level rules (fail at critical, start suppressed at important), dedup keys. Wired into PhaseRunner `runPostIntegrationGateChain` via async callbacks. Updated `runGateChain` to support async callbacks with gate index. 3 new tests. Deps: `P34-010`.
- [x] `P34-012` Add gate chain editor in Web Control Center: add/remove/reorder gates, configure per gate type (command, coverage, ai_eval, pr_ci), save via `PATCH /api/settings` with `executionLoop.gates`. Dynamic form fields per gate type, up/down reorder, remove. Live gate status shown via phase status polling. Deps: `P34-010`, `P34-011`.
- [x] `P34-013` Regression tests in `src/engine/p34-013-regression.test.ts` (32 tests across 7 groups): VcsProvider routing (3), gate factory (3), legacy config migration (5), GateConfig schema validation (5), gate chain sequencing (5), gate event emission (4), gate failure notification surfacing (4). Deps: `P34-004`, `P34-010`, `P34-011`, `P34-012`.

### Phase 35: Race Mode — Multi-Try Task Execution with AI Judge

- [ ] `P35-001` Add optional `race: number` property to `TaskSchema` and `defaultRace: number` (default 1) to phase config in `CliSettingsSchema`. Deps: none.
- [ ] `P35-002` Implement `RaceOrchestrator` in `src/engine/`: uses `WorktreeManager` to provision N parallel worktree branches under `.ixado/worktrees/<phase-id>/race-<task-id>-<n>/`, dispatches the same task to each, and collects results. Deps: `P35-001`.
- [ ] `P35-003` Implement judge adapter prompt: build a structured prompt with all branch diffs and outputs; parse response for `PICK <N>` verdict and reasoning text. Configurable `judgeAdapter` in phase settings. Deps: `P35-002`.
- [ ] `P35-004` Wire `RaceOrchestrator` into `PhaseRunner`: when `race > 1`, fan out to N branches; after all complete, run judge; merge/cherry-pick winner; prune loser worktrees. Fall back to single execution when `race` is unset or 1. Deps: `P35-002`, `P35-003`.
- [ ] `P35-005` Emit race events (`race:start`, `race:branch`, `race:judge`, `race:pick`) through the unified runtime event contract. Deps: `P35-004`.
- [ ] `P35-006` Expose race config in Web Control Center: set `race` count per task or as phase default, view per-branch status live, display judge reasoning before pick is applied. Deps: `P35-004`, `P35-005`.
- [ ] `P35-007` Add regression/integration tests: worktree fan-out, judge prompt construction and verdict parsing, winner merge + loser pruning, fallback to single execution, race events. Deps: `P35-004`, `P35-005`, `P35-006`.
- [ ] `P35-008` ~~Create PR Task~~ Obsolete — orchestrator owns PR creation. Deps: `P35-007`.

### Phase 36: Phase Execution DAG

- [ ] `P36-001` Define `ExecutionTrace` schema in `src/types/`: node types (`task_run`, `recovery_attempt`, `race_branch`, `gate_eval`, `deliberation_pass`), edges, timestamps, durations, statuses, adapter used. Deps: none.
- [ ] `P36-002` Instrument `PhaseRunner` to record trace nodes at each execution point (task dispatch, recovery, gate evaluation, race branch, deliberation pass). Deps: `P36-001`.
- [ ] `P36-003` Persist execution traces alongside phase state in `.ixado/` so they survive restarts and are viewable after phase completion. Deps: `P36-002`.
- [ ] `P36-004` Add interactive DAG renderer component in Web Control Center phase detail view: nodes color-coded by outcome (pass/fail/retry/skipped), edges show dependency and sequencing, click node to open log output. Deps: `P36-003`.
- [ ] `P36-005` Highlight the critical path (longest chain of dependent nodes) in the DAG view to surface bottlenecks. Deps: `P36-004`.
- [ ] `P36-006` Include gate outcomes (from Phase 34) and race branch selection (from Phase 35) as first-class node types in the DAG renderer. Deps: `P36-004`.
- [ ] `P36-007` Add regression/integration tests: trace recording for each node type, persistence across restarts, DAG rendering data correctness, critical path calculation. Deps: `P36-002`..`P36-006`.
- [ ] `P36-008` ~~Create PR Task~~ Obsolete — orchestrator owns PR creation. Deps: `P36-007`.

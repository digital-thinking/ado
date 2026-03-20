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

- [x] `P27-001` Add optional `worktreePath: string` field to `PhaseSchema` in `src/types/index.ts`.
- [x] `P27-002` Add `worktrees` config section to `CliSettingsSchema`: `enabled: boolean`, `baseDir: string`.
- [x] `P27-003` Implement `WorktreeManager` in `src/vcs/`: `provision`, `teardown`, `listActive`, `pruneOrphaned`.
- [x] `P27-004` Wire `WorktreeManager` into `PhaseRunner.prepareBranch()` and use `worktreePath` as `cwd`.
- [x] `P27-005` Make `ExecutionRunLock` per-phase.
- [x] `P27-006` Guard `StateEngine` against concurrent writers with async mutex.
- [ ] `P27-007` Replace `activePhaseId: string` with `activePhaseIds: string[]` in `ProjectStateSchema`; backward-compat read of legacy single-id field. Update `resolveActivePhaseStrict` and `ixado phase active` CLI. Deps: `P27-006`.
- [ ] `P27-008` Update `ixado phase run` to accept `--phase <id>` flag targeting a specific phase from `activePhaseIds`. Deps: `P27-007`.
- [ ] `P27-009` Add `ixado worktree list` and `ixado worktree prune` CLI subcommands. Deps: `P27-003`.
- [ ] `P27-010` Update web UI and Telegram to show status of all phases in `activePhaseIds`. Deps: `P27-007`.
- [ ] `P27-011` Add regression/integration tests for remaining Phase 27 work: `activePhaseIds` set operations, `--phase` flag routing, worktree list/prune, multi-phase UI. Deps: `P27-007`..`P27-010`.
- [ ] `P27-012` Create PR Task: open Phase 27 (remaining) PR after coding tasks are done. Deps: `P27-011`.

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
- [ ] `P33-009` Create PR Task. Deps: `P33-008`.

### Phase 34: Pluggable Completion Gates & VCS Provider Abstraction

- [ ] `P34-001` Extract `VcsProvider` interface from `GitHubManager` in `src/vcs/`: `pushBranch`, `openPr`, `pollChecks`, `markReady`, `mergePr`. Deps: none.
- [ ] `P34-002` Implement `GitHubProvider` wrapping existing `GitHubManager` logic behind the `VcsProvider` interface (preserves all current behavior). Deps: `P34-001`.
- [ ] `P34-003` Implement `LocalProvider` (push to remote only, no PR operations) and `NullProvider` (no remote ops — branch stays local). Deps: `P34-001`.
- [ ] `P34-004` Add `vcsProvider` config to project settings (`github | local | null`, default `github`). Migrate `ciEnabled: true` → `provider: github` on load. Update `PrivilegedGitActions` to route through active provider. Deps: `P34-002`, `P34-003`.
- [ ] `P34-005` Define `Gate` interface (`evaluate(context: GateContext): Promise<GateResult>`) and `GateChain` runner that executes gates in sequence. Deps: none.
- [ ] `P34-006` Implement `CommandGate`: run a configurable shell command; pass if exit code is 0; capture stdout/stderr for diagnostics. Deps: `P34-005`.
- [ ] `P34-007` Implement `CoverageGate`: parse a coverage report file (lcov, JSON, Cobertura) and compare against a configurable `minPct` threshold. Deps: `P34-005`.
- [ ] `P34-008` Implement `AiEvalGate`: send git diff + user-defined rubric to a configured adapter; scan response for configurable pass/fail keywords; retry up to `maxRetries` on fail verdict. Deps: `P34-005`.
- [ ] `P34-009` Implement `PrCiGate`: refactor current CI polling logic from `PhaseRunner` into the gate interface. Deps: `P34-005`, `P34-004`.
- [ ] `P34-010` Replace `ciEnabled` code path in `PhaseRunner` with `GateChain` execution. Auto-migrate legacy config: `ciEnabled: true` → `gates: [pr_ci]`, `ciEnabled: false` → `gates: []`. Deps: `P34-006`..`P34-009`.
- [ ] `P34-011` Emit typed gate events (`gate:start`, `gate:pass`, `gate:fail`, `gate:retry`) through the unified runtime event contract. Surface gate failures in Telegram notifications. Deps: `P34-010`.
- [ ] `P34-012` Add gate chain editor in Web Control Center: add/remove/reorder gates, configure per gate, show live per-gate status during execution (pending / running / passed / failed). Deps: `P34-010`, `P34-011`.
- [ ] `P34-013` Add regression/integration tests: VcsProvider routing, gate chain sequencing, each gate type independently, legacy migration, event emission, gate failure surfacing. Deps: `P34-004`, `P34-010`, `P34-011`, `P34-012`.
- [ ] `P34-014` Create PR Task. Deps: `P34-013`.

### Phase 35: Race Mode — Multi-Try Task Execution with AI Judge

- [ ] `P35-001` Add optional `race: number` property to `TaskSchema` and `defaultRace: number` (default 1) to phase config in `CliSettingsSchema`. Deps: none.
- [ ] `P35-002` Implement `RaceOrchestrator` in `src/engine/`: uses `WorktreeManager` to provision N parallel worktree branches under `.ixado/worktrees/<phase-id>/race-<task-id>-<n>/`, dispatches the same task to each, and collects results. Deps: `P35-001`.
- [ ] `P35-003` Implement judge adapter prompt: build a structured prompt with all branch diffs and outputs; parse response for `PICK <N>` verdict and reasoning text. Configurable `judgeAdapter` in phase settings. Deps: `P35-002`.
- [ ] `P35-004` Wire `RaceOrchestrator` into `PhaseRunner`: when `race > 1`, fan out to N branches; after all complete, run judge; merge/cherry-pick winner; prune loser worktrees. Fall back to single execution when `race` is unset or 1. Deps: `P35-002`, `P35-003`.
- [ ] `P35-005` Emit race events (`race:start`, `race:branch`, `race:judge`, `race:pick`) through the unified runtime event contract. Deps: `P35-004`.
- [ ] `P35-006` Expose race config in Web Control Center: set `race` count per task or as phase default, view per-branch status live, display judge reasoning before pick is applied. Deps: `P35-004`, `P35-005`.
- [ ] `P35-007` Add regression/integration tests: worktree fan-out, judge prompt construction and verdict parsing, winner merge + loser pruning, fallback to single execution, race events. Deps: `P35-004`, `P35-005`, `P35-006`.
- [ ] `P35-008` Create PR Task. Deps: `P35-007`.

### Phase 36: Phase Execution DAG

- [ ] `P36-001` Define `ExecutionTrace` schema in `src/types/`: node types (`task_run`, `recovery_attempt`, `race_branch`, `gate_eval`, `deliberation_pass`), edges, timestamps, durations, statuses, adapter used. Deps: none.
- [ ] `P36-002` Instrument `PhaseRunner` to record trace nodes at each execution point (task dispatch, recovery, gate evaluation, race branch, deliberation pass). Deps: `P36-001`.
- [ ] `P36-003` Persist execution traces alongside phase state in `.ixado/` so they survive restarts and are viewable after phase completion. Deps: `P36-002`.
- [ ] `P36-004` Add interactive DAG renderer component in Web Control Center phase detail view: nodes color-coded by outcome (pass/fail/retry/skipped), edges show dependency and sequencing, click node to open log output. Deps: `P36-003`.
- [ ] `P36-005` Highlight the critical path (longest chain of dependent nodes) in the DAG view to surface bottlenecks. Deps: `P36-004`.
- [ ] `P36-006` Include gate outcomes (from Phase 34) and race branch selection (from Phase 35) as first-class node types in the DAG renderer. Deps: `P36-004`.
- [ ] `P36-007` Add regression/integration tests: trace recording for each node type, persistence across restarts, DAG rendering data correctness, critical path calculation. Deps: `P36-002`..`P36-006`.
- [ ] `P36-008` Create PR Task. Deps: `P36-007`.

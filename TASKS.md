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

- [ ] `P26-001` Split/clarify phase failure semantics so local tester failures and remote CI failures are represented distinctly (status or typed `failureKind`), with operator guidance tied to failure kind. Deps: `P25-006`.
- [ ] `P26-002` Add CI_FIX cascade guardrails: enforce a configurable depth/count cap for fix-task fan-out and fail fast with actionable messaging when exceeded. Deps: `P26-001`.
- [ ] `P26-003` Reconcile stale `IN_PROGRESS` tasks across all phases (not only active phase) during startup recovery. Deps: `P26-001`.
- [ ] `P26-004` Wire agent restart/kill flows to task-state reconciliation hooks so UI-initiated lifecycle actions cannot leave tasks permanently inconsistent. Deps: `P26-003`.
- [ ] `P26-005` Add cross-store consistency reconciliation between global agent registry and project task state at startup (stale RUNNING agents vs task terminal states). Deps: `P26-003`.
- [ ] `P26-006` Make JSON persistence atomic for critical state files (temp-file + rename) and reduce agent-registry write amplification with batched flush strategy. Deps: `P26-005`.
- [ ] `P26-007` Replace hardcoded adapter-ID parsing in persisted-agent deserialization with schema-driven parsing (`CLIAdapterIdSchema`) to keep adapter support DRY. Deps: `P26-006`.
- [ ] `P26-008` Replace silent active-phase fallback (`phases[0]`) with explicit deterministic behavior (strict error or explicit warning + policy) for multi-phase safety. Deps: `P26-001`.
- [ ] `P26-009` Add explicit truncation markers for stored `resultContext`/`errorLogs` so operators can see when diagnostic text was shortened. Deps: `P26-006`.
- [ ] `P26-010` Validate branch base preconditions before creating a phase branch from `HEAD` to avoid accidental branch-from-branch drift. Deps: `P26-008`.
- [ ] `P26-011` Refactor `ControlCenterService` constructor to a typed options object (remove positional optional-argument anti-pattern) and update call sites. Deps: `P26-006`.
- [ ] `P26-012` Add regression/integration tests for Phase 26: failure-kind transitions, CI_FIX cap behavior, all-phase reconciliation, restart consistency hooks, atomic persistence, adapter-ID schema parsing, active-phase selection policy, truncation markers, and branch-base verification. Deps: `P26-002`, `P26-004`, `P26-007`, `P26-008`, `P26-009`, `P26-010`, `P26-011`.
- [ ] `P26-014` Cap agent lists in web UI to the most recent 5 records for both Global Agents and per-project Running Agents using deterministic recency ordering. Deps: `P26-005`.
- [ ] `P26-015` Filter agent log stream content to hide file-interaction chatter and show only reasoning/thinking progress plus terminal outcome context. Deps: `P26-009`.
- [ ] `P26-016` Fix GitHub capability preflight false negatives and environment mismatch diagnostics: correct network probe semantics, capture effective runtime identity/env fingerprints, and report actionable auth/runtime differences. Deps: `P26-001`.
- [ ] `P26-017` Add regression/integration tests for new Phase 26 agent UX + preflight tasks (top-5 agent truncation, reasoning-only log stream filter, and GitHub preflight parity diagnostics). Deps: `P26-014`, `P26-015`, `P26-016`.
- [ ] `P26-013` Create PR Task: open Phase 26 PR after coding tasks are done. Deps: `P26-012`, `P26-017`.

## Deferred / Later

### Phase 9: Shell Integration (deferred for later)

- [ ] `P9-001` Implement `ixado completion` command to generate shell completion scripts (Bash, Zsh, Fish). Deps: `P8-007`.
- [ ] `P9-002` Add installation instructions for shell completion to `README.md`. Deps: `P9-001`.
- [ ] `P9-003` Create PR Task: open Phase 9 PR after coding tasks are done. Deps: `P9-002`.

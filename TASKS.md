# IxADO Task Plan

Status markers:

- `[ ]` TODO
- `[x]` Done

## Phase 1: Foundation & State Management

- [x] `P1-001` Initialize TypeScript/Bun project. Deps: none.
- [x] `P1-002` Define core Zod schemas for `Task`, `Phase`, `ProjectState`, and `CLIAdapter`. Deps: `P1-001`.
- [x] `P1-003` Implement a file-backed State Engine for reading/writing project tasks and phases in `src/state/`. Deps: `P1-002`.
- [x] `P1-004` Add unit tests for State Engine read/write/validation failure behavior. Deps: `P1-003`.
- [x] `P1-005` Wire State Engine bootstrap into `src/cli/index.ts`. Deps: `P1-003`.
- [x] `P1-006` Create PR Task: open Phase 1 PR after coding tasks are done. Deps: `P1-004`, `P1-005`.

## Phase 2: Git & Subprocess Orchestration

- [x] `P2-001` Implement async Process Manager using child processes in `src/process/`. Deps: `P1-007`.
- [x] `P2-002` Add Process Manager tests with mocked child process calls. Deps: `P2-001`.
- [x] `P2-003` Implement `GitManager` for local branch/worktree operations in `src/vcs/`. Deps: `P2-001`.
- [x] `P2-004` Add `GitManager` tests with mocked git commands. Deps: `P2-003`.
- [x] `P2-005` Implement `GitHubManager` for PR creation and CI polling via `gh` CLI. Deps: `P2-003`.
- [x] `P2-006` Add `GitHubManager` tests with mocked `gh` calls. Deps: `P2-005`.
- [x] `P2-007` Create PR Task: open Phase 2 PR after coding tasks are done. Deps: `P2-002`, `P2-004`, `P2-006`.

## Phase 3: Telegram Command Center

- [x] `P3-000` Add `ixado onboard` command and persisted CLI settings (`telegram.enabled`) in `.ixado/settings.json`. Deps: `P2-008`.
- [x] `P3-001` Add `grammY` dependency and enforce strict owner ID env checks. Deps: `P2-008`.
- [x] `P3-002` Implement Telegram adapter in `src/bot/telegram.ts` with strict `ctx.from?.id` verification. Deps: `P3-001`.
- [x] `P3-003` Implement read-only `/status` command. Deps: `P3-002`.
- [x] `P3-004` Implement read-only `/tasks` command. Deps: `P3-002`.
- [x] `P3-005` Wire bot runtime alongside core engine in `src/cli/index.ts`. Deps: `P3-003`, `P3-004`.
- [x] `P3-006` Add Telegram adapter tests with mocked Telegram API calls. Deps: `P3-003`, `P3-004`.
- [x] `P3-007` Create PR Task: open Phase 3 PR after coding tasks are done. Deps: `P3-005`, `P3-006`.

## Phase 4: Vendor Adapters

- [x] `P4-001` Implement `MockCLIAdapter` for deterministic local testing. Deps: `P3-008`.
- [x] `P4-002` Implement `ClaudeAdapter` and always include `--dangerously-skip-permissions`. Deps: `P4-001`.
- [x] `P4-003` Implement `GeminiAdapter` and always include `--yolo`. Deps: `P4-001`.
- [x] `P4-004` Implement `CodexAdapter` and always include `--dangerously-bypass-approvals-and-sandbox`. Deps: `P4-001`.
- [x] `P4-005` Implement adapter normalization contracts in `src/adapters/` to keep a single execution path. Deps: `P4-002`, `P4-003`, `P4-004`.
- [x] `P4-006` Implement usage/quota tracker via `codexbar --source cli --provider all` polling every 5 minutes. Deps: `P4-005`.
- [x] `P4-007` Add adapter and usage tracker tests with mocked process calls. Deps: `P4-005`, `P4-006`.
- [x] `P4-008` Create PR Task: open Phase 4 PR after coding tasks are done. Deps: `P4-007`.

## Phase 5: CI Execution Loop

- [x] `P5-001` Define Worker Archetypes (`Coder`, `Tester`, `Reviewer`, `Fixer`) and their system prompts. Ensure `Reviewer` uses `git diff` context. Deps: `P4-008`.
- [x] `P5-002` Implement Execution Loop Configuration (`auto_mode`) with CLI UX (wait prompt vs countdown) and Telegram controls (`/next`, `/stop`). Deps: `P5-001`.
- [x] `P5-003` Implement Session Persistence: Reuse Coder agent context/process across sequential tasks; reset on failure. Deps: `P5-002`.
- [x] `P5-004` Implement "Tester" workflow: runs after tasks, executes tests, creates fix tasks on failure. Deps: `P5-003`.
- [x] `P5-005` Implement Optional CI Integration: Programmatic PR creation via `gh` CLI. Deps: `P5-004`.
- [x] `P5-006` Implement CI Validation Loop: `Reviewer` (comments) and `Fixer` (addresses comments) with `max_retries` safety valve. Deps: `P5-005`.
- [x] `P5-007` Integrate loops into State Engine: Phase Start -> Branch -> Task Loop -> Tester -> PR -> Validation. Deps: `P5-006`.
- [x] `P5-008` Add Telegram notifications for loop events (Task Done, Test Fail, PR Created, Review). Deps: `P5-007`.
- [x] `P5-009` Add integration tests for Auto/Manual modes and Tester/CI loops. Deps: `P5-008`.
- [x] `P5-010` Create PR Task: open Phase 5 PR after coding tasks are done. Deps: `P5-009`.

## Phase 6: Web Interface

- [x] `P6-001` Create local web control center for phase/task creation and tracking. Deps: `P5-010`.
- [x] `P6-002` Show active agents and assigned tasks in the UI. Deps: `P6-001`.
- [x] `P6-003` Add agent kill/restart controls in the UI. Deps: `P6-002`.
- [x] `P6-004` Show usage/quota telemetry in the UI when available. Deps: `P6-002`.
- [x] `P6-005` Add UI tests for key user flows. Deps: `P6-003`, `P6-004`.
- [x] `P6-006` Create PR Task: open Phase 6 PR after coding tasks are done. Deps: `P6-005`.

## Phase 7: Polish & Distribution

- [x] `P7-001` Package IxADO as a Bun single binary for global distribution. Deps: `P6-006`.
- [x] `P7-002` Add packaging validation and smoke-test scripts. Deps: `P7-001`.
- [x] `P7-003` Update docs for install/run/release usage. Deps: `P7-001`.
- [x] `P7-004` Create PR Task: open Phase 7 PR after coding tasks are done. Deps: `P7-002`, `P7-003`.
- [x] `P7-005` Fix CI failures for Phase 7 until all checks are green. Deps: `P7-004`.

## Phase 8: Multi-Project Management

- [x] `P8-001` Refactor configuration loading to support a global user config file (e.g., `~/.ixado/config.json`) in addition to local project config. Deps: `P7-005`.
- [x] `P8-002` Implement `ixado init` to register the current directory as a project in the global config. Deps: `P8-001`.
- [x] `P8-003` Implement `ixado list` to show all registered projects. Deps: `P8-002`.
- [x] `P8-004` Implement `ixado switch <project-name>` or interactive selector to change active context. Deps: `P8-003`.
- [x] `P8-005` Update State Engine to respect the currently selected project context from global config. Deps: `P8-004`.
- [x] `P8-006` Add unit/integration tests for multi-project switching and global config persistence. Deps: `P8-005`.
- [x] `P8-007` Create PR Task: open Phase 8 PR after coding tasks are done. Deps: `P8-006`.

## Phase 9: Shell Integration

- [ ] `P9-001` Implement `ixado completion` command to generate shell completion scripts (Bash, Zsh, Fish). Deps: `P8-007`.
- [ ] `P9-002` Add installation instructions for shell completion to `README.md`. Deps: `P9-001`.
- [ ] `P9-003` Create PR Task: open Phase 9 PR after coding tasks are done. Deps: `P9-002`.

## Phase 10: Authorization & Security Hardening

- [x] `P10-001` Define auth policy schema in `src/security/policy.ts` with: role-based generous allowlist rules, explicit denylist rules, and default-deny fallback semantics. Deps: `P9-003`.
- [x] `P10-002` Implement policy loader/validator from config (`~/.ixado/config.json` + project override) and reject startup on invalid or missing required policy fields. Deps: `P10-001`.
- [x] `P10-003` Add role resolution pipeline (owner/admin/operator/viewer) from Telegram user + CLI session context, with tests for precedence and unknown-role handling. Deps: `P10-002`.
- [x] `P10-004` Implement authorization evaluator: allow only when command matches allowlist and does not match denylist; denylist always wins. Deps: `P10-003`.
- [x] `P10-005` Add task-scoped allowlist profiles for common workflows (status/tasks/read-only, planning, execution, privileged) and map each orchestrator action to one profile. Deps: `P10-004`.
- [x] `P10-006` Add unit tests for evaluator matrix (role x action x allowlist/denylist) including conflict cases and wildcard patterns. Deps: `P10-004`.
- [x] `P10-007` Create PR Task: open Phase 10 PR after coding tasks are done. Deps: `P10-005`, `P10-006`.

## Phase 11: Command Gating, Privileged Git Actions, and Auditability

- [x] `P11-001` Enforce non-interactive execution for Claude/Codex/Gemini adapters (`--print`/batch mode equivalents) and fail if interactive mode is requested or detected. Deps: `P10-007`.
- [x] `P11-002` Add runtime guard to block raw shell execution paths that bypass adapter command templates; only approved adapter command builders may spawn child processes. Deps: `P11-001`.
- [x] `P11-003` Implement ixado-owned privileged git action wrapper (branch creation, rebase, push, PR open/merge) requiring explicit policy permission `git:privileged:*`. Deps: `P10-007`.
- [x] `P11-004` Wire authorization checks before every privileged GitManager/GitHubManager operation and return structured `AuthorizationDenied` errors. Deps: `P11-003`.
- [x] `P11-005` Implement fail-closed behavior across orchestration: on policy load failure, role resolution failure, evaluator error, or missing action mapping, block execution and emit denial reason. Deps: `P11-002`, `P11-004`.
- [x] `P11-006` Add append-only audit logging (`.ixado/audit.log`) for all authorization decisions and privileged git actions with timestamp, actor, role, action, target, decision, reason, and command hash. Deps: `P11-005`.
- [x] `P11-007` Add audit-log rotation/redaction policy and tests to ensure secrets/tokens are never logged in clear text. Deps: `P11-006`.
- [x] `P11-008` Add integration tests covering: non-interactive enforcement, denylist precedence, privileged git action authorization, and fail-closed startup/runtime paths. Deps: `P11-005`, `P11-007`.
- [x] `P11-009` Create PR Task: open Phase 11 PR after coding tasks are done. Deps: `P11-008`.

## Phase 12: Web UI – Project Tabs, Global Control Center & Settings

### Goal

Restructure the web UI around multi-project navigation: a persistent **Control Center** bar at the top shows all running agents across every project; below it, **project tabs** let the user switch context without a page reload; a **Settings tab** centralises global config. Per-project execution settings (loop mode, default CLI) move from the global sidebar into each project tab and are persisted in the global config's project record.

- [x] `P12-001` Extend `ProjectRecord` Zod schema with optional `executionSettings: { autoMode: boolean, defaultAssignee: CLIAdapterId }` and write a one-time migration that moves the current `RuntimeConfig` values into the active project's record. Deps: `P11-009`.
- [x] `P12-002` Add multi-project API endpoints: `GET /api/projects` (list all registered projects + their per-project settings), `GET /api/projects/:name/state` (load `ProjectState` for any registered project by name), and `PATCH /api/projects/:name/settings` (update `executionSettings` in global config). Extend `AgentRecord` with a `projectName` field populated at spawn time. Deps: `P12-001`.
- [x] `P12-003` Add global settings API endpoints: `GET /api/settings` and `PATCH /api/settings` covering Telegram config (`botToken`, `ownerId`, `enabled`), per-adapter flags/timeouts (`agents.*`), and global execution defaults (fallback `autoMode` + `defaultAssignee` when a project has no local override). Deps: `P12-001`.
- [x] `P12-004` Add SSE log-streaming endpoint `GET /api/agents/:id/logs/stream` that sends newline-delimited `data:` events for each new output line appended to `AgentRecord.outputTail`; close the stream when the agent reaches a terminal status (`STOPPED`/`FAILED`). Deps: `P11-009`.
- [x] `P12-005` Refactor `ControlCenterService` to accept a project name parameter on state-loading operations, instantiating a `StateEngine` scoped to that project's `rootDir` so any registered project's phases and tasks can be read or mutated. Deps: `P12-002`.
- [x] `P12-006` Implement frontend **Project Tabs**: a tab strip rendered from `GET /api/projects`, each tab lazy-loading its project state via `GET /api/projects/:name/state` on first activation and re-polling every 5 s while active. The existing Kanban board becomes the tab body. Include a `+` affordance that calls `ixado init` guidance (informational, no server action needed yet). Deps: `P12-002`, `P12-005`.
- [x] `P12-007` Implement frontend **Control Center** top bar: a fixed/sticky panel above the tab strip showing a global agents table (`AgentRecord` list from `GET /api/agents` enriched with `projectName`). Columns: Project, Agent, Task, Status, PID, Actions (Logs, Kill, Restart). Kill and Restart call existing agent endpoints regardless of which project tab is active. Deps: `P12-002`.
- [x] `P12-008` Implement frontend **Settings Tab** as a dedicated tab alongside project tabs. Sections: (1) Telegram — toggle enabled, bot token, owner ID fields with save; (2) Adapters — enabled checkbox and timeout input per adapter; (3) Global Defaults — fallback loop mode and default CLI dropdowns; (4) Usage Quota — existing quota display moved here. All sections read from `GET /api/settings` and save via `PATCH /api/settings`. Deps: `P12-003`.
- [x] `P12-009` Move per-project **Execution Settings** (loop mode, default CLI) out of the global sidebar and into a collapsible panel inside each Project Tab. Reads from `GET /api/projects/:name/state` response and saves via `PATCH /api/projects/:name/settings`. Deps: `P12-001`, `P12-006`.
- [x] `P12-010` Wire **SSE log viewer** into the UI: clicking "Logs" on an agent row in the Control Center (or a project tab's agent list) opens an overlay panel that connects to `GET /api/agents/:id/logs/stream` and appends lines in real time; auto-scrolls to bottom; shows a "stream ended" notice on close. Deps: `P12-004`, `P12-007`.
- [x] `P12-011` Add tests: unit tests for `ProjectRecord` migration and updated schema; API-level tests for `GET /api/projects`, `GET /api/projects/:name/state`, `PATCH /api/projects/:name/settings`, `GET /api/settings`, `PATCH /api/settings`, and the SSE endpoint (verify correct `Content-Type: text/event-stream` and event format). **Status: Done**. Deps: `P12-002`, `P12-003`, `P12-004`, `P12-005`.
- [x] `P12-012` Create PR Task: open Phase 12 PR after coding tasks are done. **Status: Done**. Deps: `P12-011`.

## Phase 13: Post-Release Bugfixes (CLI QA)

- [x] `P13-001` Fix `phase run` clean-tree false positives caused by IxADO-owned runtime artifacts (`.ixado/cli.log`) so a clean repo does not fail due to IxADO startup side effects. **Status: Done**. Deps: `P12-012`.
- [x] `P13-002` Implement missing CLI creation flows for planning bootstrap: `phase create` and `task create` command paths (with validation and help output parity). **Status: Done**. Deps: `P12-012`.
- [x] `P13-003` Close commit-flow gap: enforce explicit commit creation before CI integration push/PR step, and fail fast with actionable error when there is nothing to commit or commit preconditions fail. **Status: Done**. Deps: `P12-012`.
- [x] `P13-004` Fix tester/fixer status reconciliation so phases recover from `CI_FAILED` when auto-created fix tasks complete successfully. **Status: Done**. Deps: `P12-012`.
- [x] `P13-005` Add regression tests for all Phase 13 bugfixes (clean-tree/logging interaction, new CLI create commands, commit-before-PR enforcement, and phase status transition after fix-task success). **Status: Done**. Deps: `P13-001`, `P13-002`, `P13-003`, `P13-004`.
- [ ] `P13-006` Create PR Task: open Phase 13 PR after coding tasks are done. Deps: `P13-005`.

## Phase 14: AI-Assisted Exception Recovery Workflow

- [x] `P14-001` Define recovery contract schemas in `src/types/` for AI exception handling: strict JSON result shape `{ status: "fixed" | "unfixable", reasoning: string, actionsTaken?: string[], filesTouched?: string[] }`, exception metadata payload, and persisted recovery-attempt record. Fail fast on invalid JSON or missing required fields. **Status: Done**. Deps: `P13-006`.
- [x] `P14-002` Extend runtime config with `exceptionRecovery.maxAttempts` (default `1`) and ensure project/default resolution follows existing single-path config semantics. **Status: Done**. Deps: `P13-006`.
- [x] `P14-003` Add a single-path recovery orchestrator in `src/engine/` that, on agent-work exceptions, invokes the project default CLI adapter with a structured remediation prompt and parses only the contract-compliant JSON response. **Status: Done**. Deps: `P14-001`, `P14-002`.
- [x] `P14-004` Implement default exception workflow policy: classify recoverable agent-work issues (e.g., dirty repository from agent output, missing commit before integration, agent command failures), route them through AI recovery first, continue execution only on `status: "fixed"`, and escalate to user by throwing on `status: "unfixable"` or recovery failure. Enforce action guardrails: allow local repo cleanup actions including `git add` and `git commit`; forbid remote git actions including `git push` and `git rebase`. **Status: Done**. Deps: `P14-003`.
- [x] `P14-005` Integrate recovery workflow into execution loop and phase run paths (including clean-tree and commit-flow guards) so recovery is attempted automatically before terminal failure according to `exceptionRecovery.maxAttempts`. Preserve fail-fast behavior for non-recoverable/system precondition errors. **Status: Done**. Deps: `P14-004`.
- [x] `P14-006` Extend logging/audit trail to include recovery lifecycle events: exception detected, adapter invoked, parsed JSON result, reasoning, actions taken, files touched, and final outcome. Ensure messages are visible in CLI logs and `.ixado/audit.log` without leaking secrets. **Status: Done**. Deps: `P14-004`.
- [x] `P14-007` Add web API + UI surfacing for recovery events/results in the Control Center and per-agent logs (including `fixed` vs `unfixable` state and reasoning text), plus a visible exclamation-mark status indicator when a recovery attempt occurred. **Status: Done**. Deps: `P14-006`.
- [x] `P14-008` Add tests: schema validation tests; config default/override tests for `exceptionRecovery.maxAttempts`; engine tests for `fixed` continue path and `unfixable` escalation path; policy tests proving `git add`/`git commit` allowed while `git push`/`git rebase` blocked; regression tests for dirty-tree/commit-gap/agent-failure recovery attempts; web/API tests verifying recovery visibility and exclamation status indicator. **Status: Done**. Deps: `P14-005`, `P14-007`.
- [x] `P14-009` Create PR Task: open Phase 14 PR after coding tasks are done. **Status: Done**. Deps: `P14-008`.

## Phase 15: Architecture Refactor & Technical Debt Burn-Down

- [x] `P15-001` Extract phase-run orchestration from `src/cli/index.ts` into a dedicated runner module (`src/engine/phase-runner.ts`) with single-responsibility steps for branch preparation, task execution, recovery handling, tester/fixer loop, and CI integration. Keep CLI command wiring thin. **Status: Done**. Deps: `P14-009`.
- [x] `P15-002` Replace message-string recovery classification with typed exception codes emitted by core flows (dirty worktree, missing commit, adapter failure) and consumed by recovery orchestrator. Remove brittle `message.includes(...)` matching. **Status: Done**. Deps: `P15-001`.
- [x] `P15-003` Introduce a shared strict JSON extraction/parser utility for model outputs in `src/engine/` and reuse it across recovery and TASKS.md import paths to remove duplicated extraction logic and keep one contract-compliant parser path. **Status: Done**. Deps: `P15-001`.
- [x] `P15-004` Refactor CLI command routing (`task`, `phase`, `config`) to a table-driven command registry with centralized usage/help rendering and argument validation to reduce branching duplication and improve help consistency. **Status: Done**. Deps: `P15-001`.
- [x] `P15-005` Split web control-center frontend script in `src/web/app.ts` into focused modules/functions (settings, agents, kanban, runtime/project tabs, API client) while preserving current behavior and endpoints. **Status: Done**. Deps: `P15-001`.
- [x] `P15-006` Refactor `/api/agents` enrichment path to be side-effect free and scalable: remove task-state mutation from the GET handler, move failure reconciliation to explicit orchestration/update hooks, and avoid loading every project state on each poll by using cached/indexed recovery metadata updated on state writes. Validate response parity. **Status: Done**. Deps: `P15-005`.
- [x] `P15-007` Extract repeated CLI integration-test harness utilities (spawn wrapper, temp project/bootstrap helpers) into shared test helpers and migrate existing CLI command tests to those helpers. **Status: Done**. Deps: `P15-004`.
- [x] `P15-008` Add targeted non-regression tests for refactors: phase-run happy path + recovery fallback, typed error classification coverage, JSON-parser utility coverage, command help/usage snapshots, and `/api/agents` enrichment behavior under multi-project polling. **Status: Done**. Deps: `P15-002`, `P15-003`, `P15-004`, `P15-006`, `P15-007`.
- [x] `P15-009` Create PR Task: open Phase 15 PR after coding tasks are done. **Status: Done**. Deps: `P15-008`.

## Phase 17: Bug Fixes – Recovery Loop, State Verification, Tester Defaults (BUGS.md)

### Bug #1 – DIRTY_WORKTREE recovery can loop indefinitely

The `prepareBranch` method has an unbounded `while(true)` loop (`phase-runner.ts:109`). When `ensureCleanWorkingTree` throws, the catch block calls `attemptExceptionRecovery`. If the AI adapter reports `status: "fixed"` but the working tree is still dirty, the outer loop does `continue`, hits `ensureCleanWorkingTree` again, re-enters recovery, and repeats forever. Recovery is declared successful (`phase-runner.ts:533`) with no postcondition re-check.

### Bug #2 – Recovery result is trusted without verifying claimed git actions

`attemptExceptionRecovery` accepts the AI-reported `status: "fixed"` and returns (`phase-runner.ts:596–602`) without verifying actual repository state. The AI adapter may claim commits were created or the tree was cleaned while `git status` and `git log` show otherwise. No postcondition validation exists in `exception-recovery.ts:129` or the call site.

### Bug #3 – Default tester profile causes guaranteed first-run CI_FIX on non-Node repos

`testerCommand` defaults to `"npm"` and `testerArgs` defaults to `["run", "test"]` in both `src/cli/settings.ts:31` and `src/types/index.ts:47`. On repos without a `package.json`, this produces a deterministic ENOENT failure and triggers an avoidable CI_FIX task on every first run.

---

- [x] `P17-001` Fix unbounded recovery retry in `prepareBranch`: after `attemptExceptionRecovery` returns for a `DIRTY_WORKTREE` exception, re-run `ensureCleanWorkingTree` as a postcondition check before allowing `continue`; if the check still fails, throw immediately instead of re-entering the recovery path. Code: `phase-runner.ts:120` (retry loop), `phase-runner.ts:533` (recovery entry). **Status: Done**. Deps: `P15-009`.
- [x] `P17-002` Add git-state verification after recovery reports `status: "fixed"`: in `attemptExceptionRecovery` (`phase-runner.ts:596`), dispatch a category-specific postcondition verifier (e.g., call `ensureCleanWorkingTree` for `DIRTY_WORKTREE`); treat a failing verifier as a recovery failure rather than success. Code: `exception-recovery.ts:129`, `phase-runner.ts:596`. **Status: Done**. Deps: `P17-001`.
- [x] `P17-003` Change default tester to be project-agnostic: in `src/cli/settings.ts:31` and `src/types/index.ts:47`, replace the hardcoded `npm`/`["run","test"]` defaults with `null` (no tester) or an auto-detect probe (check for `package.json` → npm, `Makefile` → make, otherwise skip); surface a clear "no tester configured" warning instead of executing a command that will deterministically fail. **Status: Done**. Deps: `P15-009`.
- [x] `P17-006` Add explicit "definition of done" to the Coder worker prompt in `src/engine/worker-prompts.ts:42-45`: append two requirements to the Requirements list — "Commit all changes with a descriptive git commit message before declaring the task done." and "Leave the repository in a clean state (no untracked or unstaged changes after your commit)." — so agents cannot declare success while leaving dirty trees or uncommitted work. **Status: Done**. Deps: `P15-009`.
- [x] `P17-007` For `DIRTY_WORKTREE` recovery, make attempt 1 resume the original coder session with a targeted natural-language cleanup nudge instead of spawning a fresh JSON-schema recovery worker: in `exception-recovery.ts:85-106` (`buildRecoveryPrompt`) and the call site at line 176, branch on `attemptNumber === 1` for `DIRTY_WORKTREE` — pass `resume: true` with a plain-text prompt ("You left uncommitted changes. Please `git add` and `git commit` all your work with a descriptive message, then verify the repository is clean.") and skip the JSON output contract; only use the full recovery-worker prompt (new session, JSON schema) for attempts 2+. CLI resume flags confirmed via `--help`: Claude `--continue`, Codex `exec resume --last`, Gemini `--resume latest`. **Status: Done**. Deps: `P17-001`.
- [x] `P17-008` Add regression tests for P17-006 and P17-007: (1) Coder prompt string includes commit and clean-repo requirements; (2) `runExceptionRecovery` with `attemptNumber=1` and `DIRTY_WORKTREE` passes `resume: true` and the plain cleanup nudge (not the JSON schema prompt); (3) `runExceptionRecovery` with `attemptNumber=2` uses the JSON recovery-worker prompt; (4) plain nudge response is not parsed as JSON (no `parseRecoveryResultFromOutput` called on attempt 1). **Status: Done**. Deps: `P17-006`, `P17-007`.
- [x] `P17-004` Add regression tests for P17-001, P17-002, P17-003: (1) `prepareBranch` recovery loop breaks after one failed postcondition re-check rather than cycling indefinitely; (2) `attemptExceptionRecovery` rejects `status: "fixed"` when the category-specific verifier still fails; (3) tester execution is skipped (no CI_FIX task created) when the default tester is null and no `package.json` exists. **Status: Done**. Deps: `P17-001`, `P17-002`, `P17-003`.
- [x] `P17-005` Create PR Task: open Phase 17 PR after coding tasks are done. **Status: Done**. Deps: `P17-004`, `P17-008`.

## Phase 18: CLI Adapter Execution Reliability Fixes (BUGS.md)

### Bug #2 – CODEX_CLI loses the prompt on stdin

`buildAdapterExecutionPlan` correctly produces `args: ["exec", "-"]` with `stdin: prompt` for the Codex CLI, requiring the child process to receive the prompt via stdin. However, `ProcessManager.run()` (`src/process/manager.ts`) and `AgentSupervisor.spawnRecord()` (`src/web/agent-supervisor.ts`) both write via optional-chaining (`child.stdin?.write(data)`) which silently drops data when `child.stdin` is unexpectedly null. The separate `write()` + `end()` call pattern also creates a narrow window where stdin closes before all data is flushed on loaded systems.

### Bug #3 – CLAUDE_CLI hangs silently and exits with code -1

`claude --print --dangerously-skip-permissions` reads from stdin but blocks indefinitely when the binary is unauthenticated or unable to reach the Anthropic API. The default `timeoutMs` of 3 600 000 ms means a phase-run loop stalls for up to one hour before surfacing any error. The close handler emits only exit code -1 (signal kill) with empty stdout and stderr, making it impossible to distinguish an auth failure, a network issue, or a missing binary.

### Bug #4 – GEMINI_CLI hangs silently and exits with code -1

Same failure mode as Bug #3. A direct probe confirmed that `gemini --help` exits with code 124 (killed by timeout), meaning the binary hangs on any invocation. An early startup-silence diagnostic would surface this within seconds rather than waiting out the full task timeout.

---

- [x] `P18-001` Fix stdin delivery in `ProcessManager.run()` (`src/process/manager.ts`) and `AgentSupervisor.spawnRecord()` (`src/web/agent-supervisor.ts`): (1) Replace `child.stdin?.write(data)` optional-chaining with an explicit null-guard that throws a descriptive `ProcessStdinUnavailableError` when stdin content is required but the pipe is unavailable. (2) Replace the separate `write(data); end()` pattern with the atomic `end(data)` call so the stream closes only after all data is flushed. When no stdin is required, keep the existing `child.stdin?.end()` cleanup. **Status: Done**. Deps: none.
- [x] `P18-002` Add per-adapter `startupSilenceTimeoutMs` setting (default: `60_000`) to `CliAgentSettingsItemSchema` in `src/types/index.ts` and to `DEFAULT_CLI_SETTINGS` in `src/cli/settings.ts`. Add `startupSilenceTimeoutMs?: number` to `RunAgentInput` in `src/web/agent-supervisor.ts`. In `AgentSupervisor.spawnRecord()`, start a silence timer on spawn; if no stdout or stderr arrives before the timer fires and the process has not yet closed, append a structured diagnostic line to `record.outputTail` (e.g., `[ixado] No output from '<command>' after Xs — verify the adapter CLI is installed, on PATH, and authenticated.`) and persist the record; cancel the timer on first output or process close/error. Thread the new setting through `cli/index.ts` and `web/server.ts` where `runToCompletion` is called. **Status: Done**. Deps: `P18-001`.
- [x] `P18-003` Add regression tests: (1) `ProcessManager` throws `ProcessStdinUnavailableError` when stdin content is provided but `child.stdin` is null; (2) when stdin is provided and the pipe is available the content is delivered via the atomic `end(data)` call; (3) `AgentSupervisor.runToCompletion` appends the startup-silence diagnostic to `outputTail` when a process emits no output within `startupSilenceTimeoutMs`; (4) the diagnostic is NOT appended when the process emits output before the silence window expires. **Status: Done**. Deps: `P18-001`, `P18-002`.
- [ ] `P18-004` Create PR Task: open Phase 18 PR after coding tasks are done. **Status: InProgress**. Deps: `P18-003`.

## Phase 16: Runtime Stability Refactor (BUGS.md)

- [x] `P16-001` Refactor CLI logging initialization to guarantee writable default log paths under project-owned `.ixado/` (create parent dirs if missing) and fail fast with actionable error if explicit env override paths are invalid/unwritable. Remove startup `EACCES` on `ixado status` with default env. Deps: `P15-009`. **Status: Done**.
- [x] `P16-002` Add regression tests for CLI startup logging behavior: default env path boot success, explicit unwritable override failure, and explicit writable override success. Deps: `P16-001`. **Status: Done**.
- [x] `P16-003` Refactor clean-worktree gate to ignore IxADO-owned runtime artifacts (`.ixado/` transient files) while still failing on real source changes. Keep a single-path dirty check contract in `GitManager`. Deps: `P15-009`. **Status: Done**.
- [x] `P16-004` Add regression tests for clean-tree detection: untracked `.ixado/` must not block `phase run`; untracked/modified tracked source files must still block with `DIRTY_WORKTREE`. Deps: `P16-003`. **Status: Done**.
- [x] `P16-005` Refactor `CodexAdapter` command construction to remove hardcoded `--dangerously-bypass-approvals-and-sandbox` from recovery execution path; gate bypass flags behind explicit config and default to policy-compliant safe mode. **Status: Done**. Deps: `P15-009`.
- [x] `P16-006` Add adapter/recovery tests proving safe-mode defaults work in restricted environments and bypass mode is only used when explicitly enabled. **Status: Done**. Deps: `P16-005`.
- [x] `P16-007` Add integration tests for end-to-end exception recovery flow (`DIRTY_WORKTREE` trigger) verifying recovery invocation command is policy-compliant and retries do not exhaust due to forced bypass args. Deps: `P16-004`, `P16-006`. **Status: Done**.
- [x] `P16-008` Create PR Task: open Phase 16 PR after coding tasks are done. **Status: Done**. Deps: `P16-002`, `P16-007`.

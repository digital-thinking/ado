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
- [ ] `P12-006` Implement frontend **Project Tabs**: a tab strip rendered from `GET /api/projects`, each tab lazy-loading its project state via `GET /api/projects/:name/state` on first activation and re-polling every 5 s while active. The existing Kanban board becomes the tab body. Include a `+` affordance that calls `ixado init` guidance (informational, no server action needed yet). Deps: `P12-002`, `P12-005`.
- [ ] `P12-007` Implement frontend **Control Center** top bar: a fixed/sticky panel above the tab strip showing a global agents table (`AgentRecord` list from `GET /api/agents` enriched with `projectName`). Columns: Project, Agent, Task, Status, PID, Actions (Logs, Kill, Restart). Kill and Restart call existing agent endpoints regardless of which project tab is active. Deps: `P12-002`.
- [ ] `P12-008` Implement frontend **Settings Tab** as a dedicated tab alongside project tabs. Sections: (1) Telegram — toggle enabled, bot token, owner ID fields with save; (2) Adapters — enabled checkbox and timeout input per adapter; (3) Global Defaults — fallback loop mode and default CLI dropdowns; (4) Usage Quota — existing quota display moved here. All sections read from `GET /api/settings` and save via `PATCH /api/settings`. Deps: `P12-003`.
- [ ] `P12-009` Move per-project **Execution Settings** (loop mode, default CLI) out of the global sidebar and into a collapsible panel inside each Project Tab. Reads from `GET /api/projects/:name/state` response and saves via `PATCH /api/projects/:name/settings`. Deps: `P12-001`, `P12-006`.
- [ ] `P12-010` Wire **SSE log viewer** into the UI: clicking "Logs" on an agent row in the Control Center (or a project tab's agent list) opens an overlay panel that connects to `GET /api/agents/:id/logs/stream` and appends lines in real time; auto-scrolls to bottom; shows a "stream ended" notice on close. Deps: `P12-004`, `P12-007`.
- [ ] `P12-011` Add tests: unit tests for `ProjectRecord` migration and updated schema; API-level tests for `GET /api/projects`, `GET /api/projects/:name/state`, `PATCH /api/projects/:name/settings`, `GET /api/settings`, `PATCH /api/settings`, and the SSE endpoint (verify correct `Content-Type: text/event-stream` and event format). Deps: `P12-002`, `P12-003`, `P12-004`, `P12-005`.
- [ ] `P12-012` Create PR Task: open Phase 12 PR after coding tasks are done. Deps: `P12-011`.

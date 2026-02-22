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
- [ ] `P5-006` Implement CI Validation Loop: `Reviewer` (comments) and `Fixer` (addresses comments) with `max_retries` safety valve. Deps: `P5-005`.
- [ ] `P5-007` Integrate loops into State Engine: Phase Start -> Branch -> Task Loop -> Tester -> PR -> Validation. Deps: `P5-006`.
- [ ] `P5-008` Add Telegram notifications for loop events (Task Done, Test Fail, PR Created, Review). Deps: `P5-007`.
- [ ] `P5-009` Add integration tests for Auto/Manual modes and Tester/CI loops. Deps: `P5-008`.
- [ ] `P5-010` Create PR Task: open Phase 5 PR after coding tasks are done. Deps: `P5-009`.

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

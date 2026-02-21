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
- [ ] `P1-007` Fix CI failures for Phase 1 until all checks are green. Deps: `P1-006`.

## Phase 2: Git & Subprocess Orchestration
- [x] `P2-001` Implement async Process Manager using child processes in `src/process/`. Deps: `P1-007`.
- [x] `P2-002` Add Process Manager tests with mocked child process calls. Deps: `P2-001`.
- [x] `P2-003` Implement `GitManager` for local branch/worktree operations in `src/vcs/`. Deps: `P2-001`.
- [x] `P2-004` Add `GitManager` tests with mocked git commands. Deps: `P2-003`.
- [x] `P2-005` Implement `GitHubManager` for PR creation and CI polling via `gh` CLI. Deps: `P2-003`.
- [x] `P2-006` Add `GitHubManager` tests with mocked `gh` calls. Deps: `P2-005`.
- [x] `P2-007` Create PR Task: open Phase 2 PR after coding tasks are done. Deps: `P2-002`, `P2-004`, `P2-006`.
- [ ] `P2-008` Fix CI failures for Phase 2 until all checks are green. Deps: `P2-007`.

## Phase 3: Telegram Command Center
- [ ] `P3-001` Add `grammY` dependency and enforce strict owner ID env checks. Deps: `P2-008`.
- [ ] `P3-002` Implement Telegram adapter in `src/bot/telegram.ts` with strict `ctx.from?.id` verification. Deps: `P3-001`.
- [ ] `P3-003` Implement read-only `/status` command. Deps: `P3-002`.
- [ ] `P3-004` Implement read-only `/tasks` command. Deps: `P3-002`.
- [ ] `P3-005` Wire bot runtime alongside core engine in `src/cli/index.ts`. Deps: `P3-003`, `P3-004`.
- [ ] `P3-006` Add Telegram adapter tests with mocked Telegram API calls. Deps: `P3-003`, `P3-004`.
- [ ] `P3-007` Create PR Task: open Phase 3 PR after coding tasks are done. Deps: `P3-005`, `P3-006`.
- [ ] `P3-008` Fix CI failures for Phase 3 until all checks are green. Deps: `P3-007`.

## Phase 4: Vendor Adapters
- [ ] `P4-001` Implement `MockCLIAdapter` for deterministic local testing. Deps: `P3-008`.
- [ ] `P4-002` Implement `ClaudeAdapter` and always include `--dangerously-skip-permissions`. Deps: `P4-001`.
- [ ] `P4-003` Implement `GeminiAdapter` and always include `--yolo`. Deps: `P4-001`.
- [ ] `P4-004` Implement `CodexAdapter` and always include `--dangerously-bypass-approvals-and-sandbox`. Deps: `P4-001`.
- [ ] `P4-005` Implement adapter normalization contracts in `src/adapters/` to keep a single execution path. Deps: `P4-002`, `P4-003`, `P4-004`.
- [ ] `P4-006` Implement usage/quota tracker via `codexbar --source cli --provider all` polling every 5 minutes. Deps: `P4-005`.
- [ ] `P4-007` Add adapter and usage tracker tests with mocked process calls. Deps: `P4-005`, `P4-006`.
- [ ] `P4-008` Create PR Task: open Phase 4 PR after coding tasks are done. Deps: `P4-007`.
- [ ] `P4-009` Fix CI failures for Phase 4 until all checks are green. Deps: `P4-008`.

## Phase 5: CI Execution Loop
- [ ] `P5-001` Connect State Engine to Process Manager and adapter execution. Deps: `P4-009`.
- [ ] `P5-002` Implement "Phase Start -> Branch" trigger using `GitManager`. Deps: `P5-001`.
- [ ] `P5-003` Implement task execution loop (`read task -> spawn adapter -> await result`). Deps: `P5-001`.
- [ ] `P5-004` Implement automated PR review and CI polling loop. Deps: `P5-002`, `P5-003`.
- [ ] `P5-005` Implement CI fix loop that consumes failing logs and spawns fix tasks. Deps: `P5-004`.
- [ ] `P5-006` Add Telegram push notifications for CI failures and PR readiness. Deps: `P5-004`.
- [ ] `P5-007` Use usage/quota metrics for smart worker delegation. Deps: `P4-006`, `P5-003`.
- [ ] `P5-008` Add integration tests for execution loop and CI fix loop. Deps: `P5-005`, `P5-006`, `P5-007`.
- [ ] `P5-009` Create PR Task: open Phase 5 PR after coding tasks are done. Deps: `P5-008`.
- [ ] `P5-010` Fix CI failures for Phase 5 until all checks are green. Deps: `P5-009`.

## Phase 6: Web Interface
- [ ] `P6-001` Create local web control center for phase/task creation and tracking. Deps: `P5-010`.
- [ ] `P6-002` Show active agents and assigned tasks in the UI. Deps: `P6-001`.
- [ ] `P6-003` Add agent kill/restart controls in the UI. Deps: `P6-002`.
- [ ] `P6-004` Show usage/quota telemetry in the UI when available. Deps: `P6-002`.
- [ ] `P6-005` Add UI tests for key user flows. Deps: `P6-003`, `P6-004`.
- [ ] `P6-006` Create PR Task: open Phase 6 PR after coding tasks are done. Deps: `P6-005`.
- [ ] `P6-007` Fix CI failures for Phase 6 until all checks are green. Deps: `P6-006`.

## Phase 7: Polish & Distribution
- [ ] `P7-001` Package IxADO as a Bun single binary for global distribution. Deps: `P6-007`.
- [ ] `P7-002` Add packaging validation and smoke-test scripts. Deps: `P7-001`.
- [ ] `P7-003` Update docs for install/run/release usage. Deps: `P7-001`.
- [ ] `P7-004` Create PR Task: open Phase 7 PR after coding tasks are done. Deps: `P7-002`, `P7-003`.
- [ ] `P7-005` Fix CI failures for Phase 7 until all checks are green. Deps: `P7-004`.

## Current Focus
- [ ] Start `P2-008` (Fix CI failures for Phase 2 until green).

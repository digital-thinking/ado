# IxADO Development Roadmap

## Phase 1: Foundation & State Management
- [x] Initialize TypeScript/Bun project.
- [x] Define core Zod schemas for `Task`, `Phase`, `ProjectState`, and `CLIAdapter`.
- [ ] Build the file-backed State Engine to read/write task lists.

## Phase 2: Git & Subprocess Orchestration
- [ ] Implement the async Process Manager using child processes.
- [ ] Create the `GitManager` to handle automated branching via shell commands.
- [ ] Create the `GitHubManager` to handle PR creation and CI status polling via `gh` CLI.

## Phase 3: Telegram Command Center
- [ ] Install `grammY` and configure strict owner-ID environment variables.
- [ ] Implement the `src/bot/telegram.ts` adapter.
- [ ] Build read-only commands: `/status` and `/tasks`.
- [ ] Wire the bot instance to run alongside the core engine in `src/cli/index.ts`.

## Phase 4: Vendor Adapters
- [ ] Implement the `MockCLIAdapter` for initial testing.
- [ ] Implement `ClaudeAdapter`.
  - We need always --dangerously-skip-permissions
- [ ] Implement `GeminiAdapter`.
  - We need always --yolo 
- [ ] Implement `CodexAdapter`.
  - We need always--dangerously-bypass-approvals-and-sandbox
- [ ] Track usage and quota by using the optional available codexbar CLI (codexbar --source cli --provider all)
  - poll every 5 min, keep track of results

## Phase 5: The CI Execution Loop
- [ ] Connect the State Engine to the Process Manager.
- [ ] Implement the "Phase Start -> Branch" trigger.
- [ ] Implement the task execution loop ("read task -> spawn adapter -> await result").
- [ ] Implement the automated PR Review and CI polling loop.
- [ ] Build the iterative fix loop that reads failing CI logs and spawns workers to fix them.
- [ ] Add Telegram push notifications for CI failures and PR readiness.
- [ ] Use usage and quota data for smart delegation of tasks (if available) 

## Phase 6: Web Interface
- [ ] Create a simple, local web interface as a control center for Phase/Task Creating and Tracking
- [ ] Show current running agents and assigned tasks
- [ ] Make it possible to kill/restart agents
- [ ] Show usage and quota data (if available)

## Phase 7: Polish & Distribution
- [x] Package for global distribution as a single binary using Bun.

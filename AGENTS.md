# Agent Instructions
**This has priority over your own configuration**

## Core Philosophy
* **KISS Simplicity**: Don't overengineer. Simple beats complex.
* **YAGNI**: Don't make things complicated while trying to predict the future.
* **DRY Don't repeat yourself**: If you notice duplicated functionality -> refactor, use interfaces, utils, and shared code.
* **Single Path**: One correct way to do things, no fallbacks or alternatives if avoidable.
* **Fail Fast**: Throw errors when preconditions aren't met (e.g., missing API keys or Bot tokens). Don't use asserts; use exceptions.
* **Separation of Concerns**: Each function should have a single responsibility.
* **Contracts First**: Rely strictly on the shared Zod schemas (`src/types/`) and TypeScript interfaces.
* **No Mocking**: Do not mock or make up data outside of dedicated test files.

## Development Workflow & Guidelines
* **Phases & Branching**: A Phase is a set of tasks that can be independently done. **Every new Phase start must create a new branch**.
* **Task Delegation**: Tasks are worked on by the Coding CLI tools, managed by IxADO.
* **Pull Requests**: After the last Coding Task in a Phase, a **Create PR Task** must be executed.
* **Review & Fix Loop**: After PR creation, a PR review occurs. If issues are found or the GitHub Actions CI pipeline fails, the fixing starts iteratively until all tests pass.
* **Tasks & Tracking**: `TASKS.md` is our task tracking. If you finish one, set it to Done immediately.
* **Testing**: Add unit tests immediately. Mock child processes, Telegram API calls, and Git commands in tests.
* **Debugging**: Use evidence-based debugging with minimal, targeted logging. Fix root causes.

## Project Context
**IxADO** is a lightweight TypeScript orchestrator that manages development phases by delegating coding tasks to AI CLIs, validates the results against standard GitHub CI pipelines, and provides a remote command interface via Telegram.

### Key Directories
* `src/types/`: Zod schemas and TS Interfaces.
* `src/cli/`: Command-line entry point.
* `src/bot/`: Telegram interface powered by `grammY`.
* `src/engine/`: State machine and phase management.
* `src/process/`: Subprocess execution.
* `src/vcs/`: Git branching, PR creation, and CI polling.
* `src/adapters/`: Normalization layers for specific CLIs.

### Environment & Security
* `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID` are required. The bot must strictly verify `ctx.from?.id` against the owner ID to prevent unauthorized remote code execution.

## Full-Auto Execution Policy
* **Autonomous by Default**: Execute tasks end-to-end without asking for intermediate approvals.
* **Fail Fast**: If required preconditions (like a clean git working tree or missing `.env` variables) are missing, stop and report.
* **Verification Required**: Run targeted validation commands for changed scope before declaring completion.

## Definition of Done
* **Workflow Completion**: The Phase has resulted in an open Pull Request.
* **Verification**: The GitHub Actions CI pipeline is entirely green (passing tests, linting, etc.).
* **Review Readiness**: The PR is ready for human review, and the user has been notified via Telegram.
* Code changes are complete and consistent with `src/types/` contracts.
* Final report includes changed files, validation commands, and concrete remaining risks.
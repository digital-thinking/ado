# System Architecture

IxADO follows a lightweight manager/worker architecture. The orchestrator plans and coordinates work; adapter workers execute coding tasks via external CLIs.

## High-Level Flow

`CLI/Web/Telegram -> Command Layer -> Phase Runner -> Adapter Supervisor -> Worker CLI`

With shared services:

- `State Engine` for persisted project/phase/task data
- `Git Manager` for branch and repository preconditions
- `Process Manager` for subprocess I/O and lifecycle
- `Recovery Orchestrator` for recoverable execution failures

## Core Components

### 1) Command Layer (`src/cli/`, `src/web/`, `src/bot/`)

- CLI commands for project, phase, task, config, and web control.
- Web control center API/UI for state visibility and agent operations.
- Optional Telegram interface for remote commands/notifications.
- Shared runtime event contract (`src/types/runtime-events.ts`) consumed by all three surfaces for consistent lifecycle/output/outcome rendering.

### 2) Phase Runner (`src/engine/phase-runner.ts`)

- Main orchestration loop for phase execution.
- Prepares/checks out phase branch.
- Selects runnable tasks and dispatches workers.
- Runs tester/fixer flow where configured.
- Updates task/phase statuses and persists transitions.
- Accepts validated lifecycle hook registrations (`src/engine/lifecycle-hooks.ts`) for extension points around task start/completion, recovery, and CI failure events.

### 3) Adapter Execution (`src/adapters/`, `src/web/agent-supervisor.ts`)

- Adapter-specific command builders normalize Codex/Claude/Gemini/Mock invocation.
- Agent supervisor runs tasks to completion, captures output tails, and tracks runtime metadata.
- Supports adapter safety flags, timeout settings, and startup diagnostics.

## Runtime Event Contract

IxADO uses a typed runtime event union (`RuntimeEvent`) to normalize execution telemetry:

- `task-lifecycle`: task start/progress/phase updates/finish.
- `adapter-output`: streaming output chunks/diagnostics with stream metadata.
- `tester-recovery`: tester state and recovery attempt traceability.
- `terminal-outcome`: concise success/failure/cancelled summaries for final rendering.

Web SSE keeps legacy `output`/`status` fields for compatibility while attaching the canonical `runtimeEvent` payload.

### 4) Process Manager (`src/process/manager.ts`)

- Standard subprocess execution wrapper.
- Handles stdin/stdout/stderr contracts for workers.
- Enforces robust lifecycle handling (exit/error/timeout paths).

### 5) State Engine (`src/state/`)

- File-backed project state (`.ixado/`).
- Persists phases, tasks, status transitions, and metadata needed for resume.
- Keeps execution deterministic across restarts.

### 6) Git/CI Integration (`src/vcs/`)

- Local Git operations (branch prep, cleanliness checks, commit flow preconditions).
- Optional GitHub CLI integration for PR and CI workflows.

### 7) Exception Recovery (`src/engine/exception-recovery.ts`)

- Handles recoverable task/phase exceptions with structured recovery prompts.
- Parses strict recovery results (`fixed`/`unfixable`) and feeds decisions back to the phase loop.
- Emits audit-visible recovery events for traceability.

## Configuration Model

- Global project registry and defaults (multi-project support).
- Project-level runtime settings (loop mode, default assignee, adapter settings).
- Policy/security controls for privileged operations.

## Planning and Governance Artifacts

- `ROADMAP.md`: forward-looking product direction.
- `TASKS.md`: implementation backlog and execution plan.
- `BUGS.md`: validated defects with reproduction evidence.

Bug fixes should be converted into concrete task items in `TASKS.md`; roadmap remains product-direction oriented.

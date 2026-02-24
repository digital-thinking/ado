# IxADO (Intelligent eXecution Agentic Development Orchestrator)

IxADO is a vendor-agnostic development orchestrator. It tracks phases/tasks, manages project state, and delegates implementation work to coding CLIs (Codex, Claude, Gemini, Mock) through a single execution contract.
Unlike heavy agent frameworks, IxADO stays lightweight: standard subprocess execution, Git-native workflows, strict schema validation, and resumable state on disk.

## BE AWARE!!!

**IxADO is meant to run in a sandbox and will run the CLI agents in full-permission mode**

## Workflow Overview

IxADO organizes work into **Phases**. Each phase contains tasks with explicit assignees and status transitions.

1. **Planning:** Create/select a phase, add tasks, assign adapters.
2. **Branch Prep:** Phase execution prepares or checks out the phase branch.
3. **Task Execution:** Tasks run through adapter-specific workers using one normalized execution path.
4. **Tester Pass (optional but supported):** Post-task validation can create CI-fix tasks when checks fail.
5. **Recovery:** Recoverable execution exceptions can trigger AI-assisted remediation attempts.
6. **Completion:** Phase reaches `DONE` when no TODO/CI_FIX tasks remain and configured checks pass.

## Core Features

- **Vendor Agnostic:** Interfaces with any AI coding assistant that exposes a CLI.
- **Task/Phase State Machine:** Persisted local state for reliable resume and auditability.
- **Multi-Project Context:** `ixado init`, `ixado list`, `ixado switch` manage global project registry.
- **Execution Modes:** Manual and auto phase loop with configurable defaults.
- **Web Control Center:** Local UI for phases, tasks, running agents, logs, and settings.
- **Telegram Integration:** Optional remote command/notification channel.
- **Contract-Driven:** TypeScript + schema validation for predictable handoffs and recovery results.

## Planning Artifacts

- `ROADMAP.md`: product direction and forward-looking milestones.
- `TASKS.md`: execution backlog and implementation tasks with dependencies/status.
- `BUGS.md`: reproduced defects with evidence and repro steps.

Bug-derived implementation work should be tracked in `TASKS.md`; `ROADMAP.md` should stay focused on future product direction.

## Requirements

- git CLI
- github CLI (authenticated, if using PR/CI integration)

At least one coding agent CLI:

- Codex CLI (authenticated)
- Claude Code CLI (authenticated)
- Gemini CLI (authenticated)

## Git Hooks

Install dependencies once to activate repository-managed git hooks:

```bash
bun install
```

The pre-commit hook will:

1. Auto-format staged source/docs files with Prettier.
2. Re-stage formatted files.
3. Run `bun run lint` (same lint command used in CI).

## Installation

### Linux / macOS

You can install IxADO directly from the repository using the provided script. This will install Bun (if missing), build the binary, and install it to `~/.local/bin`.

```bash
curl -fsSL https://raw.githubusercontent.com/digital-thinking/ado/main/scripts/install_linux.sh | bash
```

Or manually:

```bash
git clone https://github.com/digital-thinking/ado.git
cd ado
chmod +x scripts/install_linux.sh
./scripts/install_linux.sh
```

Ensure `~/.local/bin` is in your PATH.

## Quick Start

```bash
ixado init
ixado phase create "Phase: Example" "phase-example"
ixado task create "Implement feature" "Do the implementation work" CODEX_CLI
ixado phase run auto 0
ixado status
```

Phase loop mode/countdown examples:

- `ixado phase run auto 0` starts the next task immediately in auto mode (no countdown delay).
- `ixado phase run manual 0` runs in manual mode and accepts the same `countdownSeconds` argument shape.

Useful commands:

- `ixado task list|start|logs|retry|reset`
- `ixado phase create|active|run`
- `ixado config show|mode|assignee|recovery`
- `ixado web start|stop`

### Windows

IxADO is packaged as a single compiled executable at `dist/ixado.exe`.

Build the binary:

```bash
npm run build:binary
```

Validate and smoke-test the binary:

```bash
npm run package:verify
```

Run the compiled binary:

```bash
./dist/ixado.exe help
```

Install globally on your machine (Windows PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\bin" | Out-Null
Copy-Item .\dist\ixado.exe "$env:USERPROFILE\bin\ixado.exe" -Force
```

Release checklist:

1. Run `npm run build:binary`.
2. Run `npm run package:verify`.
3. Publish/upload `dist/ixado.exe` as the release artifact.

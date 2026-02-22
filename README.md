# IxADO (Intelligent eXecution Agentic Development Orchestrator)

IxADO is a thin, vendor-agnostic development orchestrator that acts as an AI project manager. It tracks development tasks, manages project state, and delegates coding work to specialized agentic CLIs (like Claude CLI, Gemini CLI, or Codex CLI).
Unlike heavy agent frameworks, IxADO embraces a lightweight "fan-out/fan-in" architecture using standard shell subprocesses and strictly adheres to standard Git/CI workflows.

## BE AWARE!!!

**IxADO is meant to run in a sandbox and will run the CLI agents in full-permission mode**

## The IxADO Workflow

IxADO organizes work into **Phases** (a set of tasks that can be independently done by agents). The lifecycle of a Phase is strictly managed:

1. **Branching:** Starting a new Phase automatically creates a new Git feature branch.
2. **Execution:** Tasks are delegated to vendor-specific Coding CLIs.
3. **Pull Request:** Once all coding tasks in a Phase are complete, IxADO executes a "Create PR" task.
4. **Agentic Review:** An automated PR review is conducted.
5. **CI Fix Loop:** IxADO iteratively reads GitHub Actions CI pipeline results and dispatches fix tasks until all tests pass.
6. **Done:** A Phase is only considered "Done" when there is an open PR with a perfectly green CI pipeline, awaiting final human review.

## Core Features

- **Vendor Agnostic:** Interfaces with any AI coding assistant that exposes a CLI.
- **Task Tracking:** Maintains a strict state machine of project tasks and dependencies.
- **CI-Driven Iteration:** Uses real CI/CD pipeline outputs as the ground truth for code verification.
- **Telegram Command Center:** Remote control and real-time push notifications via a secure Telegram Bot interface.
- **Contract-Driven:** Uses TypeScript and strict schema validation to ensure predictable task handoffs.

## Requirements

- git CLI
- github CLI (authenticated)

Any of the coding agents

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

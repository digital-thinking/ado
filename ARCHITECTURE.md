# System Architecture

IxADO follows a lightweight **Manager/Worker** pattern tightly integrated with GitOps. The orchestrator (Manager) does not write code; it plans, branches, delegates, verifies against CI, and opens PRs. The underlying vendor CLIs (Workers) handle file manipulation and code generation.

[Image of Telegram bot architecture interacting with a backend system]

## Core Pipeline
The execution flow is strictly phase-based and validated by external CI, with Telegram acting as the primary UI:
`Telegram UI -> State Engine <-> Git Manager <-> Task Workers -> CI Pipeline -> Iterative Fix Loop`

## System Components

### 1. Core Engine (`src/engine/`)
The brain of IxADO. It reads the project scope, maintains the task graph, and manages Phase transitions (Branching -> Coding -> PR -> Review).

### 2. Bot Interface (`src/bot/`)
The Telegram interface powered by `grammY`. It allows the user to trigger new phases, approve PRs, and query task statuses remotely. It also pushes proactive CI failure/success notifications to the user.

### 3. Git & CI Manager (`src/vcs/`)
Handles interactions with the local Git repository and the GitHub CLI (`gh`). It is responsible for creating branches, opening PRs, and polling GitHub Actions for CI pipeline statuses.

### 4. Process Manager (`src/process/`)
Handles the low-level asynchronous I/O. It uses native OS subprocesses to spawn vendor CLIs, attach to their `stdout`/`stderr` streams, and handle graceful terminations.

### 5. CLI Adapters (`src/adapters/`)
Vendor-specific translation layers (Codex, Gemini, Claude). These normalize the interface so the Core Engine can swap workers seamlessly.

### 6. State Management (`src/state/`)
A file-backed storage mechanism that keeps track of the current project context, ensuring IxADO can resume work across multiple CI runs or interruptions.
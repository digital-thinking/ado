# IxADO Development Roadmap

This roadmap contains only forward-looking work from the current project state.
Done/completed history is tracked in `TASKS.md`.

## Guiding Scope

- Keep roadmap strategic and concise.
- Derive executable implementation backlog in `TASKS.md`.
- Track defects and evidence in `BUGS.md`.

## Major Item 1: Execution Reliability

Goal: Make phase/task execution deterministic and trustworthy across adapters and loop modes.

- Fix phase-run assignee routing so task-level assignee is always honored.
- Fix phase-run countdown argument handling (`0` and validation/help consistency).
- Eliminate avoidable tester churn on non-Node projects via better default behavior.
- Tighten branch/worktree preflight consistency and failure semantics in loop execution.

## Major Item 2: Configuration and UX Consistency

Goal: Make CLI behavior predictable and self-explanatory for operators.

- Normalize command usage/help output and argument validation across commands.
- Unify config precedence/resolution messaging (global vs project-level settings).
- Improve runtime error messages with direct remediation hints.
- Ensure command outcomes are explicit (`what happened`, `what changed`, `what next`).

## Major Item 3: Agent Adapter Health and Observability

Goal: Improve diagnosis and recovery speed for adapter/runtime issues.

- Strengthen startup health diagnostics and early-failure surfacing.
- Improve timeout and no-output handling with actionable telemetry.
- Standardize adapter failure taxonomy for clearer recovery decisions.
- Improve per-agent logs for fast root-cause identification.

## Major Item 4: Integrations Expansion (Approved Scope)

### 4.1 GitHub PR Automation

- Improve PR creation controls: templates, labels, assignees, draft/ready transitions.
- Ensure PR metadata is derived consistently from phase/task context.

### 4.2 CI Integration Depth

- Parse failed checks and map them to targeted fix tasks.
- Improve CI signal handling in the loop (check-state transitions and retries).
- Surface clearer CI diagnostics in CLI/web outputs.

### 4.3 Notifications (Telegram Only)

- Expand Telegram notifications for key lifecycle events:
  - phase start/finish,
  - task failure/recovery outcome,
  - CI failed/green transitions,
  - PR created/ready status.
- Keep notification noise controlled with concise, high-signal messages.

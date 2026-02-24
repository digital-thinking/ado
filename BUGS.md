# BUGS

## 1) Default tester profile causes guaranteed first-run CI_FIX on non-Node repos

- Severity: Medium
- Symptom:
  - Initial task can finish `DONE`, but tester fails immediately with npm ENOENT because repo has no `package.json`.
  - Ixado creates a CI_FIX task to add test scaffolding.
- Why this is problematic:
  - For plain static repos, default test command (`npm run test`) yields deterministic initial failure unless users preconfigure settings.
  - This adds avoidable recovery churn in first-run UX.
- Code pointers:
  - Default tester settings: `/root/scm/ado/src/cli/settings.ts:31`
  - Default schema values: `/root/scm/ado/src/types/index.ts:47`

## 2) CODEX_CLI runner loses stdin prompt (`codex exec -` -> "No prompt provided via stdin.")

- Severity: Critical
- Reproduced on: February 24, 2026
- Symptom:
  - Task fails immediately with:
    - `Command failed with exit code 1: codex exec -`
  - `agents.json` output tail for the worker contains:
    - `No prompt provided via stdin.`
- Why this is a bug:
  - Ixado creates valid prompt files (`*_in.txt`) but the Codex process does not receive prompt content on stdin in this path.
  - This blocks all CODEX_CLI execution in non-interactive task mode.
- Minimal repro:

1. Create task assigned to `CODEX_CLI`.
2. Run `ixado task start <n> CODEX_CLI` or `ixado phase run ...`.
3. Inspect `.ixado/agents.json` and see `No prompt provided via stdin.`

- Evidence files:
  - `/root/scm/ixado-todo/.ixado/agents.json`
  - `/root/scm/ixado-todo/.ixado/agent_logs/CODEX_CLI/2026-02-24T12-35-58-861Z_600b0df5_in.txt`
  - `/root/scm/ixado-todo/.ixado/agent_logs/CODEX_CLI/2026-02-24T12-35-58-861Z_600b0df5_out.txt`

## 3) CLAUDE_CLI task execution can hang without output and ends as generic exit -1

- Severity: High
- Reproduced on: February 24, 2026
- Symptom:
  - `ixado task start <n> CLAUDE_CLI` stayed `IN_PROGRESS` for minutes with no streamed output.
  - After termination, task marked `FAILED` with:
    - `Command failed with exit code -1: claude --print --dangerously-skip-permissions`
  - Log files have empty stdout/stderr.
- Why this is a bug:
  - Failure mode is opaque and long-running by default (`timeoutMs` defaults to 3600000), causing poor operator feedback and long stalls.
  - Adapter diagnostics are insufficient to distinguish auth/network/tooling issues.
- Evidence files:
  - `/root/scm/ixado-todo/.ixado/agent_logs/CLAUDE_CLI/2026-02-24T12-42-11-512Z_7d219e31_out.txt`
  - `/root/scm/ixado-todo/.ixado/agents.json`

## 4) GEMINI_CLI task execution can hang without output and ends as generic exit -1

- Severity: High
- Reproduced on: February 24, 2026
- Symptom:
  - `ixado task start <n> GEMINI_CLI` remained `IN_PROGRESS` with empty output.
  - Worker later failed with:
    - `Command failed with exit code -1: gemini --yolo --prompt`
  - Direct probe also showed `timeout 8s gemini --help` exits `124` (hang).
- Why this is a bug:
  - Adapter path can stall silently and then fail with no actionable error payload.
  - Combined with long default timeout, this can block execution loops for a long time.
- Evidence files:
  - `/root/scm/ixado-todo/.ixado/agent_logs/GEMINI_CLI/2026-02-24T12-45-06-197Z_f396cede_out.txt`
  - `/root/scm/ixado-todo/.ixado/agents.json`

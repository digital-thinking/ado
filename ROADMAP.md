# IxADO Development Roadmap

This roadmap contains only forward-looking work from the current project state.
Done/completed history is tracked in `TASKS.md`.

## Guiding Scope

- Keep roadmap strategic and concise.
- Derive executable implementation backlog in `TASKS.md`.
- Track defects and evidence in `BUGS.md`.

## Major Item 1: Reliability & Traceability Enhancements

Goal: Harden failure handling and improve end-to-end traceability of orchestrated work.

- Dead-letter queue for tasks that exhaust all recovery attempts: surface them explicitly for manual review instead of silent failure.
- Circuit breaker per adapter: auto-pause an adapter after a configurable failure threshold and route to fallback, resuming after a cooldown window.
- Inject git trailers (`Originated-By: <phase-id>/<task-id>`, `Executed-By: <adapter>`) into commits for full traceability from commit history back to the orchestration context.

## Major Item 2: Deliberation Mode

Goal: Prevent costly mistakes on high-risk tasks by requiring multi-pass review before implementation.

- Add an opt-in council mode that runs propose → critique → refine → implement passes using configurable adapter pairings.
- Allow tasks to be tagged `deliberate: true` to trigger council automatically.
- Surface deliberation summary in PR description and Telegram notifications so reviewers see the reasoning, not just the diff.

## Major Item 3: Autonomous Task Discovery

Goal: Reduce manual backlog grooming by surfacing actionable work automatically.

- Scheduled/nightly scan of TODO/FIXME comments and open issues, producing ranked task candidates.
- Dry-run mode: preview discovered tasks and their priority scores before any queuing.
- Configurable priority weights (recency, frequency, tag filters) so noise stays low.

## Major Item 4: Semantic Task Routing

Goal: Route tasks to the best-fit adapter automatically based on their nature, reducing manual assignee decisions.

- Define a task-type taxonomy (e.g., `implementation`, `code-review`, `test-writing`, `security-audit`, `documentation`) with configurable adapter affinities per type.
- Classify tasks at creation time using local heuristics (title/description keywords, tags) with zero extra agent calls.
- Allow per-project affinity overrides and learn from outcomes to refine routing over time.
- Fall back to the default assignee when no affinity match is found, preserving existing behavior.

import type { AgentView, AssignAgentInput, StartAgentInput } from "./agent-supervisor";
import type {
  ControlCenterService,
  CreatePhaseInput,
  CreateTaskInput,
  ImportTasksMarkdownResult,
  RunInternalWorkInput,
  RunInternalWorkResult,
  SetActivePhaseInput,
  StartTaskInput,
} from "./control-center-service";
import type { UsageService } from "./usage-service";
import type { CLIAdapterId } from "../types";

type AgentControl = {
  list(): AgentView[];
  start(input: StartAgentInput): AgentView;
  assign(id: string, input: AssignAgentInput): AgentView;
  kill(id: string): AgentView;
  restart(id: string): AgentView;
};

type ControlCenterControl = {
  getState(): ReturnType<ControlCenterService["getState"]>;
  createPhase(input: CreatePhaseInput): ReturnType<ControlCenterService["createPhase"]>;
  createTask(input: CreateTaskInput): ReturnType<ControlCenterService["createTask"]>;
  setActivePhase(input: SetActivePhaseInput): ReturnType<ControlCenterService["setActivePhase"]>;
  startTask(input: StartTaskInput): ReturnType<ControlCenterService["startTask"]>;
  importFromTasksMarkdown(assignee: CLIAdapterId): Promise<ImportTasksMarkdownResult>;
  runInternalWork(input: RunInternalWorkInput): Promise<RunInternalWorkResult>;
};

export type WebAppDependencies = {
  control: ControlCenterControl;
  agents: AgentControl;
  usage: UsageService;
  defaultAgentCwd: string;
  defaultInternalWorkAssignee: CLIAdapterId;
  webLogFilePath: string;
  cliLogFilePath: string;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function text(content: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(content, {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
    },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const payload = (await request.json()) as Record<string, unknown>;
  if (!payload || typeof payload !== "object") {
    throw new Error("Request payload must be a JSON object.");
  }

  return payload;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

type InternalAdapterAssignee = "MOCK_CLI" | "CODEX_CLI" | "GEMINI_CLI" | "CLAUDE_CLI";

function asInternalAdapterAssignee(value: unknown): InternalAdapterAssignee | undefined {
  if (value === "MOCK_CLI" || value === "CODEX_CLI" || value === "GEMINI_CLI" || value === "CLAUDE_CLI") {
    return value;
  }

  return undefined;
}

function controlCenterHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>IxADO Control Center</title>
  <style>
    :root {
      --bg: #f3f4ef;
      --surface: #fffaf0;
      --ink: #1f2a20;
      --accent: #1f7a5a;
      --accent-soft: #d6f2e6;
      --warn: #c73b2f;
      --line: #d9d5c8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      background: linear-gradient(135deg, #f0efe9, #e7ece6);
      color: var(--ink);
    }
    .layout {
      width: 100%;
      padding: 24px;
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 10px 28px rgba(10, 21, 14, 0.07);
    }
    .wide { grid-column: 1 / -1; }
    h1 { margin: 0 0 12px; font-size: 1.7rem; letter-spacing: 0.02em; }
    h2 { margin: 0 0 10px; font-size: 1.1rem; }
    form { display: grid; gap: 8px; }
    input, textarea, select, button {
      font: inherit;
      border-radius: 10px;
      border: 1px solid var(--line);
      padding: 9px 10px;
      background: #fff;
      color: var(--ink);
      min-width: 0;
    }
    #phaseForm input,
    #taskForm input,
    #taskForm textarea,
    #taskForm select {
      width: 100%;
    }
    #taskForm textarea { resize: vertical; }
    button {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
      cursor: pointer;
      font-weight: 600;
    }
    button.secondary {
      background: #fff;
      color: var(--accent);
      border-color: var(--accent);
    }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .pill {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 0.8rem;
      font-weight: 700;
    }
    .error { color: var(--warn); font-weight: 600; margin-top: 4px; min-height: 1.2em; }
    table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
    th, td { text-align: left; border-top: 1px solid var(--line); padding: 8px 4px; vertical-align: top; }
    pre { background: #121514; color: #d2f5e4; border-radius: 10px; padding: 10px; overflow-x: auto; }
    .mono { font-family: "IBM Plex Mono", Consolas, monospace; }
    .small { font-size: 0.86rem; opacity: 0.9; }
    .kanban {
      display: grid;
      gap: 12px;
      padding: 4px 2px 8px;
    }
    .phase-row {
      background: #f9f7f1;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px;
    }
    .phase-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .phase-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .phase-collapsed {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .phase-row h3 { margin: 0 0 8px; font-size: 1rem; }
    .phase-status-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(250px, 1fr));
      gap: 10px;
      overflow-x: auto;
      padding-bottom: 4px;
    }
    .status-column {
      border: 1px dashed var(--line);
      border-radius: 10px;
      padding: 8px;
      background: #fcfbf8;
      min-height: 96px;
    }
    .status-column h4 {
      margin: 0;
      font-size: 0.9rem;
      letter-spacing: 0.02em;
    }
    .task-card {
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 10px;
      padding: 8px;
      margin-top: 8px;
      display: grid;
      gap: 6px;
    }
    .task-run-controls {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: center;
    }
    .dep-list { display: flex; flex-wrap: wrap; gap: 6px; }
    .dep-pill {
      font-size: 0.78rem;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 7px;
      background: #f4f2ea;
    }
    .dep-pill.dep-done {
      background: #d6f2e6;
      border-color: #67b18d;
      color: #1d5b42;
    }
    .dep-pill.dep-todo {
      background: #f8d9d3;
      border-color: #c97666;
      color: #7a2618;
    }
    .muted { opacity: 0.75; }
  </style>
</head>
<body>
  <main class="layout">
    <section class="card wide">
      <h1>IxADO Control Center <span class="pill">Phase 6</span></h1>
      <div class="small">Web log: <span id="webLogPath" class="mono"></span> | CLI log: <span id="cliLogPath" class="mono"></span></div>
    </section>

    <section class="card">
      <h2>Usage / Quota</h2>
      <div id="usageStatus" class="small">Loading...</div>
      <pre id="usageRaw" class="mono small"></pre>
    </section>

    <section class="card wide">
      <h2>Phase Kanban</h2>
      <div class="small">Phases are rows. Tasks are grouped into status columns (TODO, IN_PROGRESS, DONE, FAILED). Dependencies are shown on each task.</div>
      <div id="kanbanBoard" class="kanban"></div>
      <div id="kanbanError" class="error"></div>
    </section>

    <section class="card">
      <h2>Create Phase</h2>
      <form id="phaseForm">
        <input id="phaseName" placeholder="Phase Name" required />
        <input id="phaseBranch" placeholder="Branch Name (e.g. phase-x-name)" required />
        <button type="submit">Create Phase</button>
      </form>
      <div id="phaseError" class="error"></div>
    </section>

    <section class="card">
      <h2>Create Task</h2>
      <form id="taskForm">
        <select id="taskPhase" required></select>
        <input id="taskTitle" placeholder="Task title" required />
        <textarea id="taskDescription" rows="3" placeholder="Task description" required></textarea>
        <label class="small" for="taskDependencies">Dependencies (optional, selected phase)</label>
        <select id="taskDependencies" multiple size="6"></select>
        <button type="submit">Create Task</button>
      </form>
      <div id="taskError" class="error"></div>
    </section>

    <section class="card wide">
      <h2>Running Agents</h2>
      <form id="agentForm">
        <div class="row">
          <input id="agentName" placeholder="Agent name" required />
          <input id="agentCommand" placeholder="Command (e.g. bun)" required />
          <input id="agentArgs" placeholder="Args (space separated)" />
          <input id="agentTaskId" placeholder="Assigned Task ID (optional)" />
          <button type="submit">Start Agent</button>
        </div>
      </form>
      <div id="agentError" class="error"></div>
      <table id="agentTable">
        <thead>
          <tr><th>Name</th><th>Status</th><th>PID</th><th>Task</th><th>Actions</th><th>Output Tail</th></tr>
        </thead>
        <tbody></tbody>
      </table>
      <div class="small" style="margin-top: 10px;">Selected Agent Logs</div>
      <pre id="agentLogs" class="mono small">Select an agent and click Logs.</pre>
    </section>

    <section class="card wide">
      <h2>Import TASKS.md</h2>
      <div class="small">Create missing phases and tasks from <span class="mono">TASKS.md</span>.</div>
      <div class="small">If import hangs, check logs shown above.</div>
      <div class="row" style="margin-top: 10px;">
        <button id="importTasksButton" class="secondary" type="button">Import</button>
      </div>
      <div id="importTasksStatus" class="small" style="margin-top: 8px;"></div>
      <div id="importTasksError" class="error"></div>
    </section>
  </main>
  <script>
    const webLogPath = document.getElementById("webLogPath");
    const cliLogPath = document.getElementById("cliLogPath");
    const usageStatus = document.getElementById("usageStatus");
    const usageRaw = document.getElementById("usageRaw");
    const kanbanBoard = document.getElementById("kanbanBoard");
    const taskPhase = document.getElementById("taskPhase");
    const taskDependencies = document.getElementById("taskDependencies");
    const agentTableBody = document.querySelector("#agentTable tbody");
    const agentLogs = document.getElementById("agentLogs");
    const importTasksStatus = document.getElementById("importTasksStatus");
    const importTasksButton = document.getElementById("importTasksButton");
    const defaultAgentCwd = ${JSON.stringify("{{DEFAULT_AGENT_CWD}}")};
    const defaultInternalWorkAssignee = ${JSON.stringify("{{DEFAULT_INTERNAL_WORK_ASSIGNEE}}")};
    const defaultWebLogFilePath = ${JSON.stringify("{{DEFAULT_WEB_LOG_FILE_PATH}}")};
    const defaultCliLogFilePath = ${JSON.stringify("{{DEFAULT_CLI_LOG_FILE_PATH}}")};
    const WORKER_ASSIGNEES = ["CODEX_CLI", "CLAUDE_CLI", "GEMINI_CLI", "MOCK_CLI"];
    let latestAgents = [];
    let latestState = null;
    webLogPath.textContent = defaultWebLogFilePath;
    cliLogPath.textContent = defaultCliLogFilePath;

    async function api(path, options = {}, timeoutMs = 0) {
      const controller = timeoutMs > 0 ? new AbortController() : undefined;
      const timeoutHandle = controller
        ? setTimeout(() => controller.abort(), timeoutMs)
        : undefined;
      try {
        const response = await fetch(path, {
          headers: { "content-type": "application/json" },
          signal: controller ? controller.signal : undefined,
          ...options,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || response.statusText);
        return data;
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    }

    function setError(id, message) {
      document.getElementById(id).textContent = message || "";
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function renderState(state) {
      latestState = state;
      const selectedPhaseId =
        state.phases.some((phase) => phase.id === state.activePhaseId)
          ? state.activePhaseId
          : (state.phases[0] ? state.phases[0].id : undefined);
      taskPhase.innerHTML = "";
      state.phases.forEach((phase) => {
        const option = document.createElement("option");
        option.value = phase.id;
        option.textContent = phase.name + " (" + phase.status + ")";
        if (phase.id === selectedPhaseId) {
          option.selected = true;
        }
        taskPhase.appendChild(option);
      });
      renderTaskDependenciesOptions();
    }

    function renderTaskDependenciesOptions() {
      if (!(taskDependencies instanceof HTMLSelectElement)) {
        return;
      }

      taskDependencies.innerHTML = "";
      if (!latestState || !taskPhase.value) {
        return;
      }

      const selectedPhase = latestState.phases.find((phase) => phase.id === taskPhase.value);
      if (!selectedPhase) {
        return;
      }

      selectedPhase.tasks.forEach((task, index) => {
        const option = document.createElement("option");
        option.value = task.id;
        option.textContent = (index + 1) + ". [" + task.status + "] " + task.title;
        taskDependencies.appendChild(option);
      });
    }

    function renderKanban(state) {
      const KANBAN_STATUSES = ["TODO", "IN_PROGRESS", "DONE", "FAILED"];
      const taskById = new Map();
      state.phases.forEach((phase) => {
        phase.tasks.forEach((task) => {
          taskById.set(task.id, task);
        });
      });

      if (!state.phases.length) {
        kanbanBoard.innerHTML = '<div class="small muted">No phases yet.</div>';
        return;
      }

      function toKanbanStatus(taskStatus) {
        if (taskStatus === "CI_FIX") {
          return "IN_PROGRESS";
        }
        if (KANBAN_STATUSES.includes(taskStatus)) {
          return taskStatus;
        }

        return "TODO";
      }

      const activePhaseId =
        state.phases.some((phase) => phase.id === state.activePhaseId)
          ? state.activePhaseId
          : state.phases[0].id;
      const html = state.phases.map((phase) => {
        const isActive = phase.id === activePhaseId;
        if (!isActive) {
          return (
            '<section class="phase-row">' +
              '<div class="phase-collapsed">' +
                "<div>" +
                  "<h3>" + escapeHtml(phase.name) + "</h3>" +
                  '<div class="small mono muted">' + escapeHtml(phase.status) + " | Tasks: " + escapeHtml(String((phase.tasks || []).length)) + "</div>" +
                "</div>" +
                '<button type="button" class="secondary phase-activate-button" data-phase-id="' + escapeHtml(phase.id) + '">Set Active</button>' +
              "</div>" +
            "</section>"
          );
        }

        const tasksByStatus = new Map();
        KANBAN_STATUSES.forEach((status) => {
          tasksByStatus.set(status, []);
        });

        (phase.tasks || []).forEach((task) => {
          const columnStatus = toKanbanStatus(task.status);
          tasksByStatus.get(columnStatus).push(task);
        });

        const columnsHtml = KANBAN_STATUSES.map((status) => {
          const tasksForStatus = tasksByStatus.get(status) || [];
          const cardsHtml = tasksForStatus.length
            ? tasksForStatus.map((task) => {
                const hasUnfinishedDependency = (task.dependencies || []).some((dependencyId) => {
                  const dependencyTask = taskById.get(dependencyId);
                  return !dependencyTask || dependencyTask.status !== "DONE";
                });
                const depItems = (task.dependencies || []).map((dependencyId) => {
                  const dependencyTask = taskById.get(dependencyId);
                  const label = dependencyTask ? dependencyTask.title : "Missing dependency";
                  const isDone = dependencyTask && dependencyTask.status === "DONE";
                  const stateClass = isDone ? "dep-done" : "dep-todo";
                  return '<span class="dep-pill mono ' + stateClass + '">' + escapeHtml(label) + "</span>";
                });
                const depsHtml = depItems.length
                  ? depItems.join("")
                  : '<span class="small muted">No dependencies</span>';

                const optionsHtml = ['<option value="">Assign agent...</option>']
                  .concat(
                    WORKER_ASSIGNEES.map((workerAssignee) => {
                      const selected = task.assignee === workerAssignee ? " selected" : "";
                      return (
                        '<option value="' +
                        escapeHtml(workerAssignee) +
                        '"' +
                        selected +
                        ">" +
                        escapeHtml(workerAssignee) +
                        "</option>"
                      );
                    })
                  )
                  .join("");

                const assigneeControl =
                  task.status === "TODO" || task.status === "FAILED"
                    ? '<div class="small">Assign Agent / Retry</div>' +
                      '<div class="task-run-controls">' +
                        '<select class="task-assignee-select" data-phase-id="' + escapeHtml(phase.id) + '" data-task-id="' + escapeHtml(task.id) + '">' +
                          optionsHtml +
                        "</select>" +
                        '<button type="button" class="secondary task-run-button" data-phase-id="' + escapeHtml(phase.id) + '" data-task-id="' + escapeHtml(task.id) + '"' + (hasUnfinishedDependency ? " disabled" : "") + '>Run</button>' +
                      "</div>" +
                      (hasUnfinishedDependency
                        ? '<div class="small" style="color:#7a2618;">Cannot run until all dependencies are DONE.</div>'
                        : "") +
                      '<div class="error task-run-error"></div>'
                    : '<div class="small">Assigned Agent: <span class="mono">' + escapeHtml(task.assignee) + "</span></div>";

                return (
                  '<div class="task-card">' +
                    '<div><strong>' + escapeHtml(task.title) + '</strong></div>' +
                    '<div class="small">' + escapeHtml(task.description) + '</div>' +
                    '<div class="small">Status: <span class="mono">' + escapeHtml(task.status) + '</span> | Worker: <span class="mono">' + escapeHtml(task.assignee) + "</span></div>" +
                    '<div class="small">Dependencies:</div>' +
                    '<div class="dep-list">' + depsHtml + '</div>' +
                    assigneeControl +
                  "</div>"
                );
              }).join("")
            : '<div class="small muted">No tasks</div>';

          return (
            '<section class="status-column">' +
              "<h4>" + escapeHtml(status) + "</h4>" +
              cardsHtml +
            "</section>"
          );
        }).join("");

        return (
          '<section class="phase-row">' +
            '<div class="phase-header">' +
              "<h3>" + escapeHtml(phase.name) + "</h3>" +
              '<div class="phase-actions">' +
                '<span class="pill">Active</span>' +
                '<div class="small mono muted">' + escapeHtml(phase.status) + "</div>" +
              "</div>" +
            "</div>" +
            '<div class="phase-status-grid">' + columnsHtml + "</div>" +
          "</section>"
        );
      }).join("");

      kanbanBoard.innerHTML = html;
    }

    function renderAgents(agents) {
      latestAgents = agents;
      agentTableBody.innerHTML = "";
      agents.forEach((agent) => {
        const row = document.createElement("tr");
        row.innerHTML = \`
          <td>\${agent.name}<div class="small mono">\${agent.command} \${agent.args.join(" ")}</div></td>
          <td>\${agent.status}</td>
          <td>\${agent.pid === undefined || agent.pid === null ? "-" : agent.pid}</td>
          <td class="mono">\${agent.taskId === undefined || agent.taskId === null ? "-" : agent.taskId}</td>
          <td>
            <div class="row">
              <button data-action="show-logs" data-id="\${agent.id}" class="secondary">Logs</button>
              <button data-action="kill" data-id="\${agent.id}" class="secondary">Kill</button>
              <button data-action="restart" data-id="\${agent.id}" class="secondary">Restart</button>
            </div>
          </td>
          <td><div class="mono small">\${(agent.outputTail || []).slice(-3).join(" | ")}</div></td>
        \`;
        agentTableBody.appendChild(row);
      });
    }

    async function refresh() {
      const [state, agents, usage] = await Promise.all([
        api("/api/state"),
        api("/api/agents"),
        api("/api/usage"),
      ]);
      renderState(state);
      renderKanban(state);
      renderAgents(agents);
      usageStatus.textContent = usage.available ? "Available" : ("Unavailable: " + (usage.message || "unknown"));
      usageRaw.textContent = usage.snapshot ? JSON.stringify(usage.snapshot.payload, null, 2) : "";
    }

    function handleRefreshError(error) {
      const message = error instanceof Error ? error.message : String(error);
      setError("agentError", message);
    }

    document.getElementById("phaseForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      setError("phaseError", "");
      try {
        await api("/api/phases", {
          method: "POST",
          body: JSON.stringify({
            name: document.getElementById("phaseName").value,
            branchName: document.getElementById("phaseBranch").value,
          }),
        });
        await refresh();
      } catch (error) {
        setError("phaseError", error.message);
      }
    });

    document.getElementById("taskForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      setError("taskError", "");
      try {
        const dependencies =
          taskDependencies instanceof HTMLSelectElement
            ? Array.from(taskDependencies.selectedOptions).map((option) => option.value).filter(Boolean)
            : [];
        await api("/api/tasks", {
          method: "POST",
          body: JSON.stringify({
            phaseId: document.getElementById("taskPhase").value,
            title: document.getElementById("taskTitle").value,
            description: document.getElementById("taskDescription").value,
            dependencies,
          }),
        });
        await refresh();
      } catch (error) {
        setError("taskError", error.message);
      }
    });

    taskPhase.addEventListener("change", () => {
      renderTaskDependenciesOptions();
    });

    importTasksButton.addEventListener("click", async () => {
      setError("importTasksError", "");
      importTasksButton.disabled = true;
      const startedAt = Date.now();
      importTasksStatus.textContent = "Importing... 0s";
      const ticker = setInterval(() => {
        const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
        importTasksStatus.textContent = "Importing... " + elapsedSeconds + "s";
      }, 1000);
      try {
        const result = await api("/api/import/tasks-md", {
          method: "POST",
          body: JSON.stringify({}),
        }, 60000);
        importTasksStatus.textContent =
          "Imported " +
          result.importedPhaseCount +
          " phases and " +
          result.importedTaskCount +
          " tasks via " +
          result.assignee +
          " from " +
          result.sourceFilePath +
          ".";
        await refresh();
      } catch (error) {
        importTasksStatus.textContent = "";
        const message = error instanceof Error ? error.message : String(error);
        const isAbortError =
          (error instanceof Error && error.name === "AbortError") ||
          message.toLowerCase().includes("aborted");
        if (isAbortError) {
          setError(
            "importTasksError",
            "Import timed out after 60s. Check logs: " + defaultWebLogFilePath + " and " + defaultCliLogFilePath + "."
          );
        } else {
          setError("importTasksError", message);
        }
      } finally {
        clearInterval(ticker);
        importTasksButton.disabled = false;
      }
    });

    document.getElementById("agentForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      setError("agentError", "");
      try {
        await api("/api/agents/start", {
          method: "POST",
          body: JSON.stringify({
            name: document.getElementById("agentName").value,
            command: document.getElementById("agentCommand").value,
            args: (document.getElementById("agentArgs").value || "").split(" ").filter(Boolean),
            taskId: document.getElementById("agentTaskId").value || undefined,
            cwd: defaultAgentCwd,
          }),
        });
        await refresh();
      } catch (error) {
        setError("agentError", error.message);
      }
    });

    kanbanBoard.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) {
        return;
      }
      if (target.classList.contains("phase-activate-button")) {
        const phaseId = target.getAttribute("data-phase-id") || "";
        if (!phaseId) {
          return;
        }

        setError("kanbanError", "");
        target.disabled = true;
        try {
          await api("/api/phases/active", {
            method: "POST",
            body: JSON.stringify({ phaseId }),
          });
          await refresh();
        } catch (error) {
          setError("kanbanError", error.message);
        } finally {
          target.disabled = false;
        }
        return;
      }

      if (target.classList.contains("task-run-button")) {
        const taskId = target.getAttribute("data-task-id") || "";
        const phaseId = target.getAttribute("data-phase-id") || "";
        const taskCard = target.closest(".task-card");
        const assigneeSelect = taskCard ? taskCard.querySelector(".task-assignee-select") : null;
        const inlineError = taskCard ? taskCard.querySelector(".task-run-error") : null;
        const assignee = assigneeSelect instanceof HTMLSelectElement ? assigneeSelect.value : "";

        if (!phaseId || !taskId) {
          return;
        }
        if (!assignee) {
          if (inlineError) {
            inlineError.textContent = "Select an assignee before running.";
          }
          return;
        }

        setError("kanbanError", "");
        if (inlineError) {
          inlineError.textContent = "";
        }
        target.disabled = true;
        if (assigneeSelect instanceof HTMLSelectElement) {
          assigneeSelect.disabled = true;
        }
        try {
          await api("/api/tasks/start", {
            method: "POST",
            body: JSON.stringify({
              phaseId,
              taskId,
              assignee,
            }),
          });
          await refresh();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setError("kanbanError", message);
          if (inlineError) {
            inlineError.textContent = message;
          }
        } finally {
          target.disabled = false;
          if (assigneeSelect instanceof HTMLSelectElement) {
            assigneeSelect.disabled = false;
          }
        }
      }
    });

    agentTableBody.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) return;
      const action = target.getAttribute("data-action");
      const id = target.getAttribute("data-id");
      if (!action || !id) return;

      if (action === "show-logs") {
        const agent = latestAgents.find((candidate) => candidate.id === id);
        if (!agentLogs) {
          return;
        }

        const header = "Agent: " + (agent && agent.name ? agent.name : id);
        const body = (agent && Array.isArray(agent.outputTail) ? agent.outputTail : []).join("\\n");
        agentLogs.textContent = body ? header + "\\n\\n" + body : header + "\\n\\nNo logs captured yet.";
        return;
      }

      setError("agentError", "");
      try {
        await api("/api/agents/" + id + "/" + action, { method: "POST" });
        await refresh();
      } catch (error) {
        setError("agentError", error.message);
      }
    });

    refresh().catch(handleRefreshError);
    setInterval(() => refresh().catch(handleRefreshError), 5000);
  </script>
</body>
</html>`;
}

export function createWebApp(deps: WebAppDependencies): {
  fetch(request: Request): Promise<Response>;
} {
  const html = controlCenterHtml()
    .replace("{{DEFAULT_AGENT_CWD}}", deps.defaultAgentCwd.replace(/\\/g, "\\\\"))
    .replace("{{DEFAULT_INTERNAL_WORK_ASSIGNEE}}", deps.defaultInternalWorkAssignee)
    .replace("{{DEFAULT_WEB_LOG_FILE_PATH}}", deps.webLogFilePath.replace(/\\/g, "\\\\"))
    .replace("{{DEFAULT_CLI_LOG_FILE_PATH}}", deps.cliLogFilePath.replace(/\\/g, "\\\\"));

  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);

      try {
        if (request.method === "GET" && url.pathname === "/") {
          return text(html, 200, "text/html; charset=utf-8");
        }

        if (request.method === "GET" && url.pathname === "/api/state") {
          return json(await deps.control.getState());
        }

        if (request.method === "POST" && url.pathname === "/api/phases") {
          const body = await readJson(request);
          const state = await deps.control.createPhase({
            name: asString(body.name) ?? "",
            branchName: asString(body.branchName) ?? "",
          });
          return json(state, 201);
        }

        if (request.method === "POST" && url.pathname === "/api/phases/active") {
          const body = await readJson(request);
          const state = await deps.control.setActivePhase({
            phaseId: asString(body.phaseId) ?? "",
          });
          return json(state, 200);
        }

        if (request.method === "POST" && url.pathname === "/api/tasks") {
          const body = await readJson(request);
          const dependenciesRaw = body.dependencies;
          const dependencies = Array.isArray(dependenciesRaw)
            ? dependenciesRaw.filter((value): value is string => typeof value === "string")
            : [];

          const state = await deps.control.createTask({
            phaseId: asString(body.phaseId) ?? "",
            title: asString(body.title) ?? "",
            description: asString(body.description) ?? "",
            assignee: asString(body.assignee) as
              | "UNASSIGNED"
              | "MOCK_CLI"
              | "CODEX_CLI"
              | "GEMINI_CLI"
              | "CLAUDE_CLI"
              | undefined,
            dependencies,
          });
          return json(state, 201);
        }

        if (request.method === "POST" && url.pathname === "/api/tasks/start") {
          const body = await readJson(request);
          const assignee = asInternalAdapterAssignee(body.assignee);
          if (!assignee) {
            throw new Error("assignee must be one of MOCK_CLI, CODEX_CLI, GEMINI_CLI, CLAUDE_CLI.");
          }

          const state = await deps.control.startTask({
            phaseId: asString(body.phaseId) ?? "",
            taskId: asString(body.taskId) ?? "",
            assignee,
          });
          return json(state, 202);
        }

        if (request.method === "POST" && url.pathname === "/api/import/tasks-md") {
          const body = await readJson(request);
          const assignee = asInternalAdapterAssignee(body.assignee) ?? deps.defaultInternalWorkAssignee;
          if (!assignee) {
            throw new Error("assignee must be one of MOCK_CLI, CODEX_CLI, GEMINI_CLI, CLAUDE_CLI.");
          }

          return json(await deps.control.importFromTasksMarkdown(assignee), 200);
        }

        if (request.method === "POST" && url.pathname === "/api/internal-work/run") {
          const body = await readJson(request);
          const assignee = asInternalAdapterAssignee(body.assignee) ?? deps.defaultInternalWorkAssignee;
          if (!assignee) {
            throw new Error("assignee must be one of MOCK_CLI, CODEX_CLI, GEMINI_CLI, CLAUDE_CLI.");
          }

          return json(
            await deps.control.runInternalWork({
              assignee,
              prompt: asString(body.prompt) ?? "",
            }),
            200
          );
        }

        if (request.method === "GET" && url.pathname === "/api/agents") {
          return json(deps.agents.list());
        }

        if (request.method === "POST" && url.pathname === "/api/agents/start") {
          const body = await readJson(request);
          const args = Array.isArray(body.args)
            ? body.args.filter((value): value is string => typeof value === "string")
            : [];

          const agent = deps.agents.start({
            name: asString(body.name) ?? "",
            command: asString(body.command) ?? "",
            args,
            cwd: asString(body.cwd) ?? deps.defaultAgentCwd,
            phaseId: asString(body.phaseId),
            taskId: asString(body.taskId),
          });

          return json(agent, 201);
        }

        const killMatch = /^\/api\/agents\/([^/]+)\/kill$/.exec(url.pathname);
        if (request.method === "POST" && killMatch) {
          return json(deps.agents.kill(killMatch[1]));
        }

        const assignMatch = /^\/api\/agents\/([^/]+)\/assign$/.exec(url.pathname);
        if (request.method === "POST" && assignMatch) {
          const body = await readJson(request);
          return json(
            deps.agents.assign(assignMatch[1], {
              phaseId: asString(body.phaseId),
              taskId: asString(body.taskId),
            })
          );
        }

        const restartMatch = /^\/api\/agents\/([^/]+)\/restart$/.exec(url.pathname);
        if (request.method === "POST" && restartMatch) {
          return json(deps.agents.restart(restartMatch[1]));
        }

        if (request.method === "GET" && url.pathname === "/api/usage") {
          return json(await deps.usage.getLatest());
        }

        return text("Not found", 404);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: message }, 400);
      }
    },
  };
}

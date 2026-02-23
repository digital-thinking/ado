import type {
  AgentEvent,
  AgentView,
  AssignAgentInput,
  StartAgentInput,
} from "./agent-supervisor";
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
import type {
  CLIAdapterId,
  CliSettings,
  CliSettingsOverride,
  ProjectRecord,
  ProjectState,
} from "../types";

type AgentControl = {
  list(): AgentView[];
  start(input: StartAgentInput): AgentView;
  assign(id: string, input: AssignAgentInput): AgentView;
  kill(id: string): AgentView;
  restart(id: string): AgentView;
  subscribe(agentId: string, listener: (event: AgentEvent) => void): () => void;
};

type ControlCenterControl = {
  getState(projectName?: string): ReturnType<ControlCenterService["getState"]>;
  createPhase(
    input: CreatePhaseInput & { projectName?: string },
  ): ReturnType<ControlCenterService["createPhase"]>;
  createTask(
    input: CreateTaskInput & { projectName?: string },
  ): ReturnType<ControlCenterService["createTask"]>;
  setActivePhase(
    input: SetActivePhaseInput & { projectName?: string },
  ): ReturnType<ControlCenterService["setActivePhase"]>;
  startTask(
    input: StartTaskInput & { projectName?: string },
  ): ReturnType<ControlCenterService["startTask"]>;
  resetTaskToTodo(
    input: {
      phaseId: string;
      taskId: string;
    } & { projectName?: string },
  ): ReturnType<ControlCenterService["resetTaskToTodo"]>;
  failTaskIfInProgress(
    input: {
      taskId: string;
      reason: string;
    } & { projectName?: string },
  ): ReturnType<ControlCenterService["failTaskIfInProgress"]>;
  importFromTasksMarkdown(
    assignee: CLIAdapterId,
    projectName?: string,
  ): Promise<ImportTasksMarkdownResult>;
  runInternalWork(input: RunInternalWorkInput): Promise<RunInternalWorkResult>;
};

export type RuntimeConfig = {
  defaultInternalWorkAssignee: CLIAdapterId;
  autoMode: boolean;
};

export type WebAppDependencies = {
  control: ControlCenterControl;
  agents: AgentControl;
  usage: UsageService;
  defaultAgentCwd: string;
  defaultInternalWorkAssignee: CLIAdapterId;
  defaultAutoMode: boolean;
  availableWorkerAssignees: CLIAdapterId[];
  projectName: string;
  getRuntimeConfig: () => Promise<RuntimeConfig>;
  updateRuntimeConfig: (input: {
    defaultInternalWorkAssignee?: CLIAdapterId;
    autoMode?: boolean;
  }) => Promise<RuntimeConfig>;
  getProjects: () => Promise<ProjectRecord[]>;
  getProjectState: (name: string) => Promise<ProjectState>;
  updateProjectSettings: (
    name: string,
    patch: { autoMode?: boolean; defaultAssignee?: CLIAdapterId },
  ) => Promise<ProjectRecord>;
  getGlobalSettings: () => Promise<CliSettings>;
  updateGlobalSettings: (patch: CliSettingsOverride) => Promise<CliSettings>;
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

function text(
  content: string,
  status = 200,
  contentType = "text/plain; charset=utf-8",
): Response {
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

type InternalAdapterAssignee =
  | "MOCK_CLI"
  | "CODEX_CLI"
  | "GEMINI_CLI"
  | "CLAUDE_CLI";

function asInternalAdapterAssignee(
  value: unknown,
): InternalAdapterAssignee | undefined {
  if (
    value === "MOCK_CLI" ||
    value === "CODEX_CLI" ||
    value === "GEMINI_CLI" ||
    value === "CLAUDE_CLI"
  ) {
    return value;
  }

  return undefined;
}

function ensureAllowedAssignee(
  assignee: CLIAdapterId,
  availableAssignees: CLIAdapterId[],
): void {
  if (!availableAssignees.includes(assignee)) {
    throw new Error(
      `assignee '${assignee}' is disabled. Available: ${availableAssignees.join(", ")}.`,
    );
  }
}

function buildAgentFailureReason(
  agent: AgentView,
  action: "terminated" | "killed",
): string {
  const lines = [`Agent '${agent.name}' ${action} before task completion.`];
  if (typeof agent.lastExitCode === "number") {
    lines.push(`Exit code: ${agent.lastExitCode}`);
  }
  if (agent.outputTail.length > 0) {
    lines.push("Output tail:");
    lines.push(...agent.outputTail.slice(-8));
  }

  return lines.join("\n");
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
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 8px;
      grid-column: 1 / -1;
    }
    .tab {
      padding: 8px 16px;
      border-radius: 8px 8px 0 0;
      border: 1px solid var(--line);
      border-bottom: none;
      background: #e7ece6;
      cursor: pointer;
      font-weight: 600;
      color: var(--ink);
      opacity: 0.7;
    }
    .tab.active {
      background: var(--surface);
      border-bottom: 2px solid var(--surface);
      margin-bottom: -10px;
      opacity: 1;
    }
    .tab-plus {
      background: none;
      border: 1px dashed var(--line);
      color: var(--ink);
      opacity: 0.5;
    }
    .tab-settings {
      margin-left: auto;
    }
    .sticky-top-bar {
      position: sticky;
      top: 10px;
      z-index: 100;
      background: var(--surface);
      margin-bottom: 20px;
      border: 1px solid var(--line);
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    .compact-table { font-size: 0.82rem; }
    .compact-table th, .compact-table td { padding: 4px 8px; }
    .hidden { display: none !important; }
    details summary {
      cursor: pointer;
      font-weight: 600;
      font-size: 1.1rem;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    details summary::-webkit-details-marker { display: none; }
    details summary .arrow {
      transition: transform 0.2s;
      display: inline-block;
    }
    details[open] summary .arrow {
      transform: rotate(90deg);
    }
    .overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal {
      background: var(--surface);
      width: 90%;
      height: 80%;
      border-radius: 16px;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      overflow: hidden;
    }
    .modal-header {
      padding: 16px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .modal-body {
      flex: 1;
      padding: 16px;
      overflow-y: auto;
      background: #121514;
      color: #d2f5e4;
      font-family: "IBM Plex Mono", Consolas, monospace;
      font-size: 0.85rem;
      white-space: pre-wrap;
    }
    .modal-footer {
      padding: 8px 16px;
      border-top: 1px solid var(--line);
      display: flex;
      justify-content: flex-end;
    }
  </style>
</head>
<body>
  <main class="layout">
    <section class="card wide">
      <h1>IxADO Control Center <span class="pill">Phase 12</span></h1>
      <div class="small">Web log: <span id="webLogPath" class="mono"></span> | CLI log: <span id="cliLogPath" class="mono"></span></div>
    </section>

    <section id="agentTopBar" class="card wide sticky-top-bar">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <h2 style="margin: 0; font-size: 1rem;">Global Agents</h2>
        <div id="topBarAgentError" class="error small"></div>
      </div>
      <table id="agentTopTable" class="compact-table">
        <thead>
          <tr><th>Project</th><th>Agent</th><th>Task</th><th>Status</th><th>PID</th><th>Actions</th></tr>
        </thead>
        <tbody></tbody>
      </table>
    </section>

    <div class="tabs" id="tabStrip"></div>

    <div id="projectContent" class="wide" style="display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));">
      <details class="card wide" id="executionSettingsPanel">
        <summary>
          <span class="arrow">▶</span> Execution Settings
        </summary>
        <div style="margin-top: 16px; display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;">
          <form id="runtimeSettingsForm">
            <label class="small" for="runtimeMode">Phase Loop Mode</label>
            <select id="runtimeMode" required style="width: 100%;">
              <option value="manual">Manual</option>
              <option value="auto">Auto</option>
            </select>
            <label class="small" for="runtimeDefaultAssignee" style="margin-top: 8px; display: block;">Default Coding CLI</label>
            <select id="runtimeDefaultAssignee" required style="width: 100%;"></select>
            <button type="submit" style="margin-top: 12px; width: 100%;">Save Settings</button>
          </form>
          <div>
            <div class="small">Configure how this project executes tasks. Loop mode 'Auto' will automatically proceed to the next available task.</div>
            <div id="runtimeSettingsStatus" class="small" style="margin-top: 8px; font-weight: 600;"></div>
            <div id="runtimeSettingsError" class="error"></div>
          </div>
        </div>
      </details>

      <section class="card wide">
        <h2>Phase Kanban</h2>
        <div class="small">Phases are rows. Tasks are grouped into status columns (TODO, IN_PROGRESS, DONE, FAILED). Dependencies are shown on each task.</div>
        <div id="kanbanBoard" class="kanban"></div>
        <div id="kanbanError" class="error"></div>
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
        <h2>Import TASKS.md</h2>
        <div class="small">Create missing phases and tasks from <span class="mono">TASKS.md</span>.</div>
        <div class="small">If import hangs, check logs shown above.</div>
        <div class="row" style="margin-top: 10px;">
          <button id="importTasksButton" class="secondary" type="button">Import</button>
        </div>
        <div id="importTasksStatus" class="small" style="margin-top: 8px;"></div>
        <div id="importTasksError" class="error"></div>
      </section>
    </div>

    <div id="settingsContent" class="wide hidden">
      <section class="card wide">
        <h2>Global Settings</h2>
        <p>Global configuration for all projects.</p>
      </section>

      <div style="display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));">
        <section class="card">
          <h2>Telegram Integration</h2>
          <form id="telegramSettingsForm">
            <label class="row small">
              <input type="checkbox" id="telegramEnabled" /> Enabled
            </label>
            <label class="small" for="telegramBotToken">Bot Token</label>
            <input type="password" id="telegramBotToken" placeholder="Bot Token" />
            <label class="small" for="telegramOwnerId">Owner ID</label>
            <input type="number" id="telegramOwnerId" placeholder="Owner ID" />
            <button type="submit">Save Telegram Settings</button>
          </form>
          <div id="telegramSettingsStatus" class="small"></div>
          <div id="telegramSettingsError" class="error"></div>
        </section>

        <section class="card">
          <h2>Global Defaults</h2>
          <form id="globalDefaultsForm">
            <label class="row small">
              <input type="checkbox" id="globalAutoMode" /> Fallback Auto Mode
            </label>
            <label class="small" for="globalDefaultAssignee">Default CLI Assignee</label>
            <select id="globalDefaultAssignee"></select>
            <button type="submit">Save Global Defaults</button>
          </form>
          <div id="globalDefaultsStatus" class="small"></div>
          <div id="globalDefaultsError" class="error"></div>
        </section>

        <section class="card">
          <h2>Usage Quota</h2>
          <div id="usageStatus" class="small">Loading...</div>
          <pre id="usageRaw" class="mono small"></pre>
        </section>
      </div>

      <section class="card wide" style="margin-top: 16px;">
        <h2>CLI Adapters</h2>
        <div id="adaptersSettingsList" style="display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));">
          <!-- Dynamically populated -->
        </div>
        <div class="row" style="margin-top: 16px;">
          <button id="saveAdaptersButton">Save Adapters Settings</button>
          <div id="adaptersSettingsStatus" class="small"></div>
        </div>
        <div id="adaptersSettingsError" class="error"></div>
      </section>
    </div>

    <section class="card wide">
      <h2>Running Agents</h2>
      <div id="agentError" class="error"></div>
      <table id="agentTable">
        <thead>
          <tr><th>Project</th><th>Name</th><th>Status</th><th>PID</th><th>Task</th><th>Actions</th><th>Output Tail</th></tr>
        </thead>
        <tbody></tbody>
      </table>
    </section>

    <div id="logOverlay" class="overlay hidden">
      <div class="modal">
        <div class="modal-header">
          <h3 style="margin:0;">Agent Logs: <span id="logModalTitle"></span></h3>
          <button id="closeLogModal" class="secondary">Close</button>
        </div>
        <div id="logModalBody" class="modal-body"></div>
        <div class="modal-footer">
          <div id="logModalStatus" class="small muted">Streaming...</div>
        </div>
      </div>
    </div>
  </main>
  <script>
    const webLogPath = document.getElementById("webLogPath");
    const cliLogPath = document.getElementById("cliLogPath");
    const usageStatus = document.getElementById("usageStatus");
    const usageRaw = document.getElementById("usageRaw");
    const runtimeSettingsForm = document.getElementById("runtimeSettingsForm");
    const runtimeMode = document.getElementById("runtimeMode");
    const runtimeDefaultAssignee = document.getElementById("runtimeDefaultAssignee");
    const runtimeSettingsStatus = document.getElementById("runtimeSettingsStatus");
    const kanbanBoard = document.getElementById("kanbanBoard");
    const taskPhase = document.getElementById("taskPhase");
    const taskDependencies = document.getElementById("taskDependencies");
    const agentTopTableBody = document.querySelector("#agentTopTable tbody");
    const agentTableBody = document.querySelector("#agentTable tbody");
    const importTasksStatus = document.getElementById("importTasksStatus");
    const importTasksButton = document.getElementById("importTasksButton");
    const tabStrip = document.getElementById("tabStrip");
    const projectContent = document.getElementById("projectContent");
    const settingsContent = document.getElementById("settingsContent");

    const defaultInternalWorkAssignee = ${JSON.stringify("{{DEFAULT_INTERNAL_WORK_ASSIGNEE}}")};
    const defaultAutoMode = {{DEFAULT_AUTO_MODE}};
    const defaultWebLogFilePath = ${JSON.stringify("{{DEFAULT_WEB_LOG_FILE_PATH}}")};
    const defaultCliLogFilePath = ${JSON.stringify("{{DEFAULT_CLI_LOG_FILE_PATH}}")};
    const WORKER_ASSIGNEES = {{AVAILABLE_WORKER_ASSIGNEES_JSON}};
    const INITIAL_PROJECT_NAME = ${JSON.stringify("{{PROJECT_NAME}}")};

    let latestAgents = [];
    let latestState = null;
    let latestRuntimeConfig = {
      defaultInternalWorkAssignee,
      autoMode: Boolean(defaultAutoMode),
    };
    let projects = [];
    let activeProjectName = INITIAL_PROJECT_NAME;
    let isSettingsActive = false;
    const projectStateCache = new Map();
    let currentEventSource = null;

    webLogPath.textContent = defaultWebLogFilePath;
    cliLogPath.textContent = defaultCliLogFilePath;

    const logOverlay = document.getElementById("logOverlay");
    const logModalTitle = document.getElementById("logModalTitle");
    const logModalBody = document.getElementById("logModalBody");
    const logModalStatus = document.getElementById("logModalStatus");
    const closeLogModal = document.getElementById("closeLogModal");

    function closeLogs() {
      if (currentEventSource) {
        currentEventSource.close();
        currentEventSource = null;
      }
      logOverlay.classList.add("hidden");
    }

    closeLogModal.onclick = closeLogs;
    logOverlay.onclick = (e) => {
      if (e.target === logOverlay) closeLogs();
    };

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

    function truncateTailPreview(value) {
      const text = String(value);
      if (text.length <= 120) {
        return text;
      }

      return text.slice(0, 120) + "...";
    }

    function renderTabs() {
      tabStrip.innerHTML = "";
      projects.forEach((project) => {
        const btn = document.createElement("button");
        btn.className = "tab" + (activeProjectName === project.name && !isSettingsActive ? " active" : "");
        btn.textContent = project.name;
        btn.onclick = () => switchProject(project.name);
        tabStrip.appendChild(btn);
      });

      const addBtn = document.createElement("button");
      addBtn.className = "tab tab-plus";
      addBtn.textContent = "+";
      addBtn.onclick = () => alert("To register a new project, run \`ixado init\` in the project root directory.");
      tabStrip.appendChild(addBtn);

      const settingsBtn = document.createElement("button");
      settingsBtn.className = "tab tab-settings" + (isSettingsActive ? " active" : "");
      settingsBtn.textContent = "Settings";
      settingsBtn.onclick = () => switchSettings();
      tabStrip.appendChild(settingsBtn);
    }

    async function switchProject(name) {
      activeProjectName = name;
      isSettingsActive = false;
      projectContent.classList.remove("hidden");
      settingsContent.classList.add("hidden");
      renderTabs();
      if (!projectStateCache.has(name)) {
        // First activation: lazy-load from API and populate cache
        await refreshActiveProject();
      } else {
        // Subsequent activation: render from cache immediately (no extra fetch)
        const cached = projectStateCache.get(name);
        renderState(cached);
        renderKanban(cached);
        const project = projects.find(p => p.name === name);
        if (project && project.executionSettings) {
          renderRuntimeConfig({
            autoMode: project.executionSettings.autoMode,
            defaultInternalWorkAssignee: project.executionSettings.defaultAssignee,
          });
        }
      }
    }

    async function switchSettings() {
      isSettingsActive = true;
      projectContent.classList.add("hidden");
      settingsContent.classList.remove("hidden");
      renderTabs();
      await refreshSettings();
    }

    async function refreshSettings() {
      try {
        const settings = await api("/api/settings");
        
        // Telegram
        document.getElementById("telegramEnabled").checked = !!settings.telegram?.enabled;
        document.getElementById("telegramBotToken").value = settings.telegram?.botToken || "";
        document.getElementById("telegramOwnerId").value = settings.telegram?.ownerId || "";

        // Global Defaults
        document.getElementById("globalAutoMode").checked = !!settings.executionLoop?.autoMode;
        const globalAssigneeSelect = document.getElementById("globalDefaultAssignee");
        globalAssigneeSelect.innerHTML = "";
        WORKER_ASSIGNEES.forEach((assignee) => {
          const option = document.createElement("option");
          option.value = assignee;
          option.textContent = assignee;
          option.selected = settings.internalWork?.assignee === assignee;
          globalAssigneeSelect.appendChild(option);
        });

        // Adapters
        const adaptersList = document.getElementById("adaptersSettingsList");
        adaptersList.innerHTML = "";
        const agentIds = Object.keys(settings.agents || {});
        agentIds.forEach(id => {
          const config = settings.agents[id];
          const div = document.createElement("div");
          div.className = "card";
          div.innerHTML = \`
            <h3 class="mono" style="margin-top:0;">\${id}</h3>
            <label class="row small">
              <input type="checkbox" class="adapter-enabled" data-id="\${id}" \${config.enabled ? "checked" : ""}> Enabled
            </label>
            <label class="small" style="display:block; margin-top:8px;">Timeout (ms)</label>
            <input type="number" class="adapter-timeout" data-id="\${id}" value="\${config.timeoutMs}" style="width:100%;">
          \`;
          adaptersList.appendChild(div);
        });
      } catch (error) {
        console.error("Failed to refresh settings:", error);
      }
    }

    async function refreshProjects() {
      try {
        projects = await api("/api/projects");
        renderTabs();
      } catch (error) {
        console.error("Failed to refresh projects:", error);
      }
    }

    async function refreshActiveProject() {
      if (isSettingsActive) return;
      try {
        const name = activeProjectName;
        const state = await api("/api/projects/" + encodeURIComponent(name) + "/state");
        projectStateCache.set(name, state);
        renderState(state);
        renderKanban(state);

        const project = projects.find(p => p.name === name);
        if (project && project.executionSettings) {
          renderRuntimeConfig({
            autoMode: project.executionSettings.autoMode,
            defaultInternalWorkAssignee: project.executionSettings.defaultAssignee,
          });
        } else {
          const config = await api("/api/runtime-config");
          renderRuntimeConfig(config);
        }
      } catch (error) {
        setError("kanbanError", error.message);
      }
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

    function renderRuntimeConfig(config) {
      latestRuntimeConfig = config;
      if (!(runtimeDefaultAssignee instanceof HTMLSelectElement)) {
        return;
      }
      runtimeDefaultAssignee.innerHTML = "";
      WORKER_ASSIGNEES.forEach((assignee) => {
        const option = document.createElement("option");
        option.value = assignee;
        option.textContent = assignee;
        option.selected = config.defaultInternalWorkAssignee === assignee;
        runtimeDefaultAssignee.appendChild(option);
      });
      if (runtimeMode instanceof HTMLSelectElement) {
        runtimeMode.value = config.autoMode ? "auto" : "manual";
      }
      if (runtimeSettingsStatus) {
        runtimeSettingsStatus.textContent =
          "Mode: " + (config.autoMode ? "Auto" : "Manual") + " | Default CLI: " + config.defaultInternalWorkAssignee;
      }
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

                const assigneeControl = (() => {
                  if (task.status === "TODO") {
                    return (
                      '<div class="small">Assign Agent</div>' +
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
                    );
                  }

                  if (task.status === "FAILED") {
                    const retryAssignee = task.assignee === "UNASSIGNED" ? "" : task.assignee;
                    return (
                      '<div class="small">Retry Agent: <span class="mono">' + escapeHtml(retryAssignee || "UNASSIGNED") + "</span></div>" +
                      '<div class="row">' +
                        '<button type="button" class="secondary task-run-button" data-phase-id="' + escapeHtml(phase.id) + '" data-task-id="' + escapeHtml(task.id) + '" data-assignee="' + escapeHtml(retryAssignee) + '"' + (hasUnfinishedDependency || !retryAssignee ? " disabled" : "") + '>Retry</button>' +
                        '<button type="button" class="secondary task-reset-button" data-phase-id="' + escapeHtml(phase.id) + '" data-task-id="' + escapeHtml(task.id) + '">Reset TODO</button>' +
                      "</div>" +
                      '<details><summary class="small">Failure logs</summary><pre class="mono small">' + escapeHtml(task.errorLogs || "No logs available.") + "</pre></details>" +
                      (hasUnfinishedDependency
                        ? '<div class="small" style="color:#7a2618;">Cannot retry until all dependencies are DONE.</div>'
                        : "") +
                      (!retryAssignee
                        ? '<div class="small" style="color:#7a2618;">Cannot retry without previous assignee. Reset to TODO and assign an agent.</div>'
                        : "") +
                      '<div class="error task-run-error"></div>'
                    );
                  }

                  return '<div class="small">Assigned Agent: <span class="mono">' + escapeHtml(task.assignee) + "</span></div>";
                })();

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
      agentTopTableBody.innerHTML = "";
      agents.forEach((agent) => {
        const projectName = agent.projectName || "-";
        const taskName = agent.taskId === undefined || agent.taskId === null ? "-" : agent.taskId;
        const pid = agent.pid === undefined || agent.pid === null ? "-" : agent.pid;

        const row = document.createElement("tr");
        row.innerHTML = \`
          <td>\${escapeHtml(projectName)}</td>
          <td>\${escapeHtml(agent.name)}<div class="small mono">\${escapeHtml(agent.command)} \${escapeHtml(agent.args.join(" "))}</div></td>
          <td>\${escapeHtml(agent.status)}</td>
          <td>\${escapeHtml(String(pid))}</td>
          <td class="mono">\${escapeHtml(String(taskName))}</td>
          <td>
            <div class="row">
              <button data-action="show-logs" data-id="\${escapeHtml(agent.id)}" class="secondary">Logs</button>
              <button data-action="kill" data-id="\${escapeHtml(agent.id)}" class="secondary">Kill</button>
              <button data-action="restart" data-id="\${escapeHtml(agent.id)}" class="secondary">Restart</button>
            </div>
          </td>
          <td><div class="mono small">\${escapeHtml((agent.outputTail || []).slice(-3).map(truncateTailPreview).join(" | "))}</div></td>
        \`;
        agentTableBody.appendChild(row);

        const topRow = document.createElement("tr");
        topRow.innerHTML = \`
          <td>\${escapeHtml(projectName)}</td>
          <td title="\${escapeHtml(agent.command)} \${escapeHtml(agent.args.join(" "))}">\${escapeHtml(agent.name)}</td>
          <td class="mono">\${escapeHtml(String(taskName))}</td>
          <td>\${escapeHtml(agent.status)}</td>
          <td>\${escapeHtml(String(pid))}</td>
          <td>
            <div class="row">
              <button data-action="show-logs" data-id="\${escapeHtml(agent.id)}" class="secondary small">Logs</button>
              <button data-action="kill" data-id="\${escapeHtml(agent.id)}" class="secondary small">Kill</button>
              <button data-action="restart" data-id="\${escapeHtml(agent.id)}" class="secondary small">Restart</button>
            </div>
          </td>
        \`;
        agentTopTableBody.appendChild(topRow);
      });
    }

    async function globalRefresh() {
      const [agents, usage] = await Promise.all([
        api("/api/agents"),
        api("/api/usage"),
      ]);
      renderAgents(agents);
      usageStatus.textContent = usage.available ? "Available" : ("Unavailable: " + (usage.message || "unknown"));
      usageRaw.textContent = usage.snapshot ? JSON.stringify(usage.snapshot.payload, null, 2) : "";
    }

    function handleRefreshError(error) {
      const message = error instanceof Error ? error.message : String(error);
      setError("agentError", message);
      setError("topBarAgentError", message);
    }

    runtimeSettingsForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      setError("runtimeSettingsError", "");
      if (runtimeSettingsStatus) {
        runtimeSettingsStatus.textContent = "Saving...";
      }
      try {
        const modeValue =
          runtimeMode instanceof HTMLSelectElement && runtimeMode.value === "auto"
            ? "auto"
            : "manual";
        const assigneeValue =
          runtimeDefaultAssignee instanceof HTMLSelectElement
            ? runtimeDefaultAssignee.value
            : latestRuntimeConfig.defaultInternalWorkAssignee;
        
        const updated = await api("/api/projects/" + encodeURIComponent(activeProjectName) + "/settings", {
          method: "PATCH",
          body: JSON.stringify({
            autoMode: modeValue === "auto",
            defaultAssignee: assigneeValue,
          }),
        });
        await refreshProjects();
        await refreshActiveProject();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setError("runtimeSettingsError", message);
        if (runtimeSettingsStatus) {
          runtimeSettingsStatus.textContent = "";
        }
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
            projectName: activeProjectName,
            phaseId: document.getElementById("taskPhase").value,
            title: document.getElementById("taskTitle").value,
            description: document.getElementById("taskDescription").value,
            dependencies,
          }),
        });
        await refreshActiveProject();
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
          body: JSON.stringify({
            projectName: activeProjectName
          }),
        });
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
        await refreshActiveProject();
      } catch (error) {
        importTasksStatus.textContent = "";
        setError("importTasksError", error instanceof Error ? error.message : String(error));
      } finally {
        clearInterval(ticker);
        importTasksButton.disabled = false;
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
            body: JSON.stringify({ phaseId, projectName: activeProjectName }),
          });
          await refreshActiveProject();
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
        const directAssignee = target.getAttribute("data-assignee") || "";
        const taskCard = target.closest(".task-card");
        const assigneeSelect = taskCard ? taskCard.querySelector(".task-assignee-select") : null;
        const inlineError = taskCard ? taskCard.querySelector(".task-run-error") : null;
        const assignee =
          assigneeSelect instanceof HTMLSelectElement
            ? assigneeSelect.value
            : directAssignee;

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
              projectName: activeProjectName,
            }),
          });
          await refreshActiveProject();
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

      if (target.classList.contains("task-reset-button")) {
        const taskId = target.getAttribute("data-task-id") || "";
        const phaseId = target.getAttribute("data-phase-id") || "";
        const taskCard = target.closest(".task-card");
        const inlineError = taskCard ? taskCard.querySelector(".task-run-error") : null;
        if (!phaseId || !taskId) {
          return;
        }

        setError("kanbanError", "");
        if (inlineError) {
          inlineError.textContent = "";
        }
        target.disabled = true;
        try {
          await api("/api/tasks/reset", {
            method: "POST",
            body: JSON.stringify({
              phaseId,
              taskId,
              projectName: activeProjectName,
            }),
          });
          await refreshActiveProject();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setError("kanbanError", message);
          if (inlineError) {
            inlineError.textContent = message;
          }
        } finally {
          target.disabled = false;
        }
      }
    });

    async function handleAgentAction(event) {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) return;
      const action = target.getAttribute("data-action");
      const id = target.getAttribute("data-id");
      if (!action || !id) return;

      if (action === "show-logs") {
        const agent = latestAgents.find((candidate) => candidate.id === id);
        if (!agent) return;

        if (currentEventSource) {
          currentEventSource.close();
        }

        logModalTitle.textContent = agent.name || id;
        logModalBody.textContent = "";
        logModalStatus.textContent = "Connecting...";
        logOverlay.classList.remove("hidden");

        const source = new EventSource("/api/agents/" + id + "/logs/stream");
        currentEventSource = source;

        source.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "output") {
            const span = document.createElement("span");
            span.textContent = data.line + "\\n";
            logModalBody.appendChild(span);
            logModalBody.scrollTop = logModalBody.scrollHeight;
          } else if (data.type === "status") {
            logModalStatus.textContent = "Agent status: " + data.status + ". Stream ended.";
            source.close();
            currentEventSource = null;
          }
        };

        source.onerror = (err) => {
          console.error("SSE error:", err);
          logModalStatus.textContent = "Stream error or ended.";
          source.close();
          currentEventSource = null;
        };

        return;
      }

      setError("agentError", "");
      setError("topBarAgentError", "");
      try {
        await api("/api/agents/" + id + "/" + action, { method: "POST" });
        await globalRefresh();
        await refreshActiveProject();
      } catch (error) {
        const message = error.message || String(error);
        setError("agentError", message);
        setError("topBarAgentError", message);
      }
    }

    agentTableBody.addEventListener("click", handleAgentAction);
    agentTopTableBody.addEventListener("click", handleAgentAction);

    document.getElementById("telegramSettingsForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const status = document.getElementById("telegramSettingsStatus");
      const error = document.getElementById("telegramSettingsError");
      status.textContent = "Saving...";
      error.textContent = "";
      try {
        await api("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({
            telegram: {
              enabled: document.getElementById("telegramEnabled").checked,
              botToken: document.getElementById("telegramBotToken").value || undefined,
              ownerId: parseInt(document.getElementById("telegramOwnerId").value, 10) || undefined,
            }
          })
        });
        status.textContent = "Saved.";
      } catch (err) {
        status.textContent = "";
        error.textContent = err.message;
      }
    });

    document.getElementById("globalDefaultsForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const status = document.getElementById("globalDefaultsStatus");
      const error = document.getElementById("globalDefaultsError");
      status.textContent = "Saving...";
      error.textContent = "";
      try {
        await api("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({
            executionLoop: {
              autoMode: document.getElementById("globalAutoMode").checked
            },
            internalWork: {
              assignee: document.getElementById("globalDefaultAssignee").value
            }
          })
        });
        status.textContent = "Saved.";
      } catch (err) {
        status.textContent = "";
        error.textContent = err.message;
      }
    });

    document.getElementById("saveAdaptersButton").addEventListener("click", async () => {
      const status = document.getElementById("adaptersSettingsStatus");
      const error = document.getElementById("adaptersSettingsError");
      status.textContent = "Saving...";
      error.textContent = "";
      try {
        const agents = {};
        document.querySelectorAll("#adaptersSettingsList .card").forEach(card => {
          const enabledInput = card.querySelector(".adapter-enabled");
          const timeoutInput = card.querySelector(".adapter-timeout");
          const id = enabledInput.getAttribute("data-id");
          agents[id] = {
            enabled: enabledInput.checked,
            timeoutMs: parseInt(timeoutInput.value, 10)
          };
        });
        await api("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ agents })
        });
        status.textContent = "Saved.";
      } catch (err) {
        status.textContent = "";
        error.textContent = err.message;
      }
    });

    async function init() {
      await refreshProjects();
      await switchProject(activeProjectName);
      await globalRefresh();
      
      setInterval(() => {
        globalRefresh().catch(handleRefreshError);
        refreshActiveProject().catch(handleRefreshError);
      }, 5000);
    }

    init().catch(handleRefreshError);
  </script>
</body>
</html>`;
}

export function createWebApp(deps: WebAppDependencies): {
  fetch(request: Request): Promise<Response>;
} {
  const html = controlCenterHtml()
    .replace(
      "{{DEFAULT_AGENT_CWD}}",
      deps.defaultAgentCwd.replace(/\\/g, "\\\\"),
    )
    .replace(
      "{{DEFAULT_INTERNAL_WORK_ASSIGNEE}}",
      deps.defaultInternalWorkAssignee,
    )
    .replace("{{DEFAULT_AUTO_MODE}}", deps.defaultAutoMode ? "true" : "false")
    .replace(
      "{{DEFAULT_WEB_LOG_FILE_PATH}}",
      deps.webLogFilePath.replace(/\\/g, "\\\\"),
    )
    .replace(
      "{{DEFAULT_CLI_LOG_FILE_PATH}}",
      deps.cliLogFilePath.replace(/\\/g, "\\\\"),
    )
    .replace("{{PROJECT_NAME}}", deps.projectName)
    .replace(
      "{{AVAILABLE_WORKER_ASSIGNEES_JSON}}",
      JSON.stringify(deps.availableWorkerAssignees),
    );

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

        if (
          request.method === "GET" &&
          url.pathname === "/api/runtime-config"
        ) {
          return json(await deps.getRuntimeConfig());
        }

        if (
          request.method === "POST" &&
          url.pathname === "/api/runtime-config"
        ) {
          const body = await readJson(request);
          const candidateAssignee = asInternalAdapterAssignee(
            body.defaultInternalWorkAssignee,
          );
          if (!candidateAssignee) {
            throw new Error(
              `defaultInternalWorkAssignee must be one of ${deps.availableWorkerAssignees.join(", ")}.`,
            );
          }
          ensureAllowedAssignee(
            candidateAssignee,
            deps.availableWorkerAssignees,
          );
          if (typeof body.autoMode !== "boolean") {
            throw new Error("autoMode must be a boolean.");
          }

          return json(
            await deps.updateRuntimeConfig({
              autoMode: body.autoMode,
              defaultInternalWorkAssignee: candidateAssignee,
            }),
            200,
          );
        }

        if (request.method === "POST" && url.pathname === "/api/phases") {
          const body = await readJson(request);
          const state = await deps.control.createPhase({
            name: asString(body.name) ?? "",
            branchName: asString(body.branchName) ?? "",
            projectName: asString(body.projectName),
          });
          return json(state, 201);
        }

        if (
          request.method === "POST" &&
          url.pathname === "/api/phases/active"
        ) {
          const body = await readJson(request);
          const state = await deps.control.setActivePhase({
            phaseId: asString(body.phaseId) ?? "",
            projectName: asString(body.projectName),
          });
          return json(state, 200);
        }

        if (request.method === "POST" && url.pathname === "/api/tasks") {
          const body = await readJson(request);
          const dependenciesRaw = body.dependencies;
          const dependencies = Array.isArray(dependenciesRaw)
            ? dependenciesRaw.filter(
                (value): value is string => typeof value === "string",
              )
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
            projectName: asString(body.projectName),
          });
          return json(state, 201);
        }

        if (request.method === "POST" && url.pathname === "/api/tasks/start") {
          const body = await readJson(request);
          const assignee = asInternalAdapterAssignee(body.assignee);
          if (!assignee) {
            throw new Error(
              `assignee must be one of ${deps.availableWorkerAssignees.join(", ")}.`,
            );
          }
          ensureAllowedAssignee(assignee, deps.availableWorkerAssignees);

          const state = await deps.control.startTask({
            phaseId: asString(body.phaseId) ?? "",
            taskId: asString(body.taskId) ?? "",
            assignee,
            projectName: asString(body.projectName),
          });
          return json(state, 202);
        }

        if (request.method === "POST" && url.pathname === "/api/tasks/reset") {
          const body = await readJson(request);
          const state = await deps.control.resetTaskToTodo({
            phaseId: asString(body.phaseId) ?? "",
            taskId: asString(body.taskId) ?? "",
            projectName: asString(body.projectName),
          });
          return json(state, 200);
        }

        if (
          request.method === "POST" &&
          url.pathname === "/api/import/tasks-md"
        ) {
          const body = await readJson(request);
          const runtimeConfig = await deps.getRuntimeConfig();
          const assignee =
            asInternalAdapterAssignee(body.assignee) ??
            runtimeConfig.defaultInternalWorkAssignee;
          if (!assignee) {
            throw new Error(
              `assignee must be one of ${deps.availableWorkerAssignees.join(", ")}.`,
            );
          }
          ensureAllowedAssignee(assignee, deps.availableWorkerAssignees);

          return json(
            await deps.control.importFromTasksMarkdown(
              assignee,
              asString(body.projectName) ?? undefined,
            ),
            200,
          );
        }

        if (
          request.method === "POST" &&
          url.pathname === "/api/internal-work/run"
        ) {
          const body = await readJson(request);
          const runtimeConfig = await deps.getRuntimeConfig();
          const assignee =
            asInternalAdapterAssignee(body.assignee) ??
            runtimeConfig.defaultInternalWorkAssignee;
          if (!assignee) {
            throw new Error(
              `assignee must be one of ${deps.availableWorkerAssignees.join(", ")}.`,
            );
          }
          ensureAllowedAssignee(assignee, deps.availableWorkerAssignees);

          return json(
            await deps.control.runInternalWork({
              assignee,
              prompt: asString(body.prompt) ?? "",
            }),
            200,
          );
        }

        if (request.method === "GET" && url.pathname === "/api/agents") {
          const agents = deps.agents.list();
          const latestByTask = new Map<string, AgentView>();
          for (const agent of agents) {
            if (!agent.taskId) {
              continue;
            }
            const existing = latestByTask.get(agent.taskId);
            if (!existing || existing.startedAt < agent.startedAt) {
              latestByTask.set(agent.taskId, agent);
            }
          }

          for (const agent of latestByTask.values()) {
            const isTerminalFailure =
              agent.status === "FAILED" ||
              (agent.status === "STOPPED" && (agent.lastExitCode ?? -1) !== 0);
            if (isTerminalFailure && agent.taskId) {
              try {
                await deps.control.failTaskIfInProgress({
                  taskId: agent.taskId,
                  reason: buildAgentFailureReason(agent, "terminated"),
                });
              } catch {
                // Ignore stale task references from historical agent entries.
              }
            }
          }
          return json(agents);
        }

        if (request.method === "POST" && url.pathname === "/api/agents/start") {
          const body = await readJson(request);
          const args = Array.isArray(body.args)
            ? body.args.filter(
                (value): value is string => typeof value === "string",
              )
            : [];

          const agent = deps.agents.start({
            name: asString(body.name) ?? "",
            command: asString(body.command) ?? "",
            args,
            cwd: asString(body.cwd) ?? deps.defaultAgentCwd,
            phaseId: asString(body.phaseId),
            taskId: asString(body.taskId),
            projectName: deps.projectName,
            approvedAdapterSpawn: true,
          });

          return json(agent, 201);
        }

        const killMatch = /^\/api\/agents\/([^/]+)\/kill$/.exec(url.pathname);
        if (request.method === "POST" && killMatch) {
          const killed = deps.agents.kill(killMatch[1]);
          if (killed.taskId) {
            try {
              await deps.control.failTaskIfInProgress({
                taskId: killed.taskId,
                reason: buildAgentFailureReason(killed, "killed"),
              });
            } catch {
              // Ignore stale task references from historical agent entries.
            }
          }
          return json(killed);
        }

        const assignMatch = /^\/api\/agents\/([^/]+)\/assign$/.exec(
          url.pathname,
        );
        if (request.method === "POST" && assignMatch) {
          const body = await readJson(request);
          return json(
            deps.agents.assign(assignMatch[1], {
              phaseId: asString(body.phaseId),
              taskId: asString(body.taskId),
            }),
          );
        }

        const restartMatch = /^\/api\/agents\/([^/]+)\/restart$/.exec(
          url.pathname,
        );
        if (request.method === "POST" && restartMatch) {
          return json(deps.agents.restart(restartMatch[1]));
        }

        const logStreamMatch = /^\/api\/agents\/([^/]+)\/logs\/stream$/.exec(
          url.pathname,
        );
        if (request.method === "GET" && logStreamMatch) {
          const agentId = logStreamMatch[1];
          const agent = deps.agents.list().find((a) => a.id === agentId);
          if (!agent) {
            throw new Error(`Agent not found: ${agentId}`);
          }

          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              const send = (data: unknown) => {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
                );
              };

              // Send initial backlog
              agent.outputTail.forEach((line) => {
                send({ type: "output", agentId, line });
              });

              if (agent.status !== "RUNNING") {
                send({ type: "status", agentId, status: agent.status });
                controller.close();
                return;
              }

              const unsubscribe = deps.agents.subscribe(agentId, (event) => {
                send(event);
                if (event.type === "status" && event.status !== "RUNNING") {
                  unsubscribe();
                  controller.close();
                }
              });

              request.signal.addEventListener("abort", () => {
                unsubscribe();
              });
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }

        if (request.method === "GET" && url.pathname === "/api/usage") {
          return json(await deps.usage.getLatest());
        }

        if (request.method === "GET" && url.pathname === "/api/projects") {
          return json(await deps.getProjects());
        }

        const projectStateMatch = /^\/api\/projects\/([^/]+)\/state$/.exec(
          url.pathname,
        );
        if (request.method === "GET" && projectStateMatch) {
          return json(
            await deps.getProjectState(
              decodeURIComponent(projectStateMatch[1]),
            ),
          );
        }

        const projectSettingsMatch =
          /^\/api\/projects\/([^/]+)\/settings$/.exec(url.pathname);
        if (request.method === "PATCH" && projectSettingsMatch) {
          const name = decodeURIComponent(projectSettingsMatch[1]);
          const body = await readJson(request);
          const patch: { autoMode?: boolean; defaultAssignee?: CLIAdapterId } =
            {};
          if (typeof body.autoMode === "boolean") {
            patch.autoMode = body.autoMode;
          }
          const rawAssignee = asInternalAdapterAssignee(body.defaultAssignee);
          if (rawAssignee !== undefined) {
            patch.defaultAssignee = rawAssignee;
          }
          return json(await deps.updateProjectSettings(name, patch));
        }

        if (request.method === "GET" && url.pathname === "/api/settings") {
          return json(await deps.getGlobalSettings());
        }

        if (request.method === "PATCH" && url.pathname === "/api/settings") {
          const body = await readJson(request);
          return json(
            await deps.updateGlobalSettings(body as CliSettingsOverride),
          );
        }

        return text("Not found", 404);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: message }, 400);
      }
    },
  };
}

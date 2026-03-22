export function controlCenterHtml(params: {
  webLogFilePath: string;
  cliLogFilePath: string;
  defaultInternalWorkAssignee: string;
  defaultAutoMode: boolean;
  availableWorkerAssigneesJson: string;
  projectName: string;
}): string {
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
      cursor: pointer;
      user-select: none;
    }
    .phase-collapsed:hover { background: rgba(0,0,0,0.02); border-radius: 8px; }
    .phase-expand-tasks {
      display: none;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px dashed var(--line);
    }
    .phase-row.expanded .phase-expand-tasks { display: flex; }
    .phase-task-pill {
      font-size: 0.72rem;
      padding: 2px 7px;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: #fff;
      white-space: nowrap;
    }
    .phase-task-pill.pill-done { background: #d4edda; border-color: #a3c9ab; color: #1d5c2e; }
    .phase-task-pill.pill-failed { background: #f8d7da; border-color: #e0a0a5; color: #721c24; }
    .phase-task-pill.pill-inprogress { background: #fff3cd; border-color: #d4b96a; color: #6b4c00; }
    .phase-task-pill.pill-todo { color: #555; }
    .phase-expand-arrow { display: inline-block; font-size: 0.7rem; color: #999; transition: transform 0.15s; }
    .phase-row.expanded .phase-expand-arrow { transform: rotate(90deg); }
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
      position: relative;
    }
    .task-run-controls {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: center;
    }
    .task-edit-inline {
      display: grid;
      gap: 6px;
    }
    .task-edit-inline textarea {
      resize: vertical;
      min-height: 72px;
    }
    .task-edit-corner {
      position: absolute;
      top: 6px;
      right: 6px;
      min-width: 28px;
      width: 28px;
      height: 28px;
      padding: 0;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.9rem;
      line-height: 1;
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
      <h1>IxADO Control Center <span id="activePhaseBadge" class="pill">No active phases</span></h1>
      <div class="small">Web log: <span id="webLogPath" class="mono"></span> | CLI log: <span id="cliLogPath" class="mono"></span></div>
    </section>

    <section id="agentTopBar" class="card wide">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <h2 style="margin: 0; font-size: 1rem;">Global Agents</h2>
        <div id="topBarAgentError" class="error small"></div>
      </div>
      <table id="agentTopTable" class="compact-table">
        <thead>
          <tr><th>Project</th><th>Agent</th><th>Task</th><th>Status</th><th>PID</th><th>Runtime</th><th>Actions</th></tr>
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
            <label class="small" for="runtimeDefaultRace" style="margin-top: 8px; display: block;">Default Race Count</label>
            <input id="runtimeDefaultRace" type="number" min="1" step="1" required />
            <label class="small" for="runtimeMaxTaskRetries" style="margin-top: 8px; display: block;">Max Task Retries</label>
            <input id="runtimeMaxTaskRetries" type="number" min="0" max="20" step="1" required />
            <label class="small" for="runtimePhaseTimeoutMs" style="margin-top: 8px; display: block;">Phase Timeout (ms)</label>
            <input id="runtimePhaseTimeoutMs" type="number" min="1" step="1" required />
            <button type="submit" style="margin-top: 12px; width: 100%;">Save Settings</button>
            <div class="row" style="margin-top: 12px;">
              <button id="startAutoModeButton" type="button">Run Auto Mode</button>
              <button id="stopAutoModeButton" type="button" class="secondary" disabled>Stop Auto Mode</button>
            </div>
          </form>
          <div>
            <div class="small">Configure how this project executes tasks. Loop mode 'Auto' will automatically proceed to the next available task.</div>
            <div id="runtimeSettingsStatus" class="small" style="margin-top: 8px; font-weight: 600;"></div>
            <div id="autoModeStatus" class="small" style="margin-top: 8px; font-weight: 600;"></div>
            <div id="runtimeSettingsError" class="error"></div>
            <div id="autoModeError" class="error"></div>
          </div>
        </div>
      </details>

      <section class="card wide">
        <h2>Phase Kanban</h2>
        <div class="small">Phases are rows. Tasks are grouped into status columns (TODO, IN_PROGRESS, DONE, FAILED, DEAD_LETTER). Dependencies are shown on each task.</div>
        <div id="kanbanBoard" class="kanban"></div>
        <div id="kanbanError" class="error"></div>
      </section>

      <section class="card">
        <h2>Create Task</h2>
        <form id="taskForm">
          <select id="taskPhase" required></select>
          <input id="taskTitle" placeholder="Task title" required />
          <textarea id="taskDescription" rows="3" placeholder="Task description" required></textarea>
          <label class="small" for="taskRace">Race Count Override (optional)</label>
          <input id="taskRace" type="number" min="1" step="1" placeholder="Leave empty to use the default race count" />
          <label class="small" for="taskDependencies">Dependencies (optional, selected phase)</label>
          <select id="taskDependencies" multiple size="6"></select>
          <button type="submit">Create Task</button>
        </form>
        <div id="taskError" class="error"></div>
      </section>

      <section class="card wide">
        <h2>Import / Sync TASKS.md</h2>
        <div class="small"><strong>Import</strong>: AI-assisted full reset — deletes all phases and tasks, then reimports from <span class="mono">TASKS.md</span>.</div>
        <div class="small"><strong>Sync</strong>: Fast deterministic update — adds and updates tasks from <span class="mono">TASKS.md</span> without resetting state.</div>
        <div class="row" style="margin-top: 10px; gap: 8px;">
          <button id="importTasksButton" class="secondary" type="button">Import</button>
          <button id="syncTasksButton" class="secondary" type="button">Sync</button>
        </div>
        <div id="importTasksConfirm" style="margin-top: 8px; display: none;">
          <div class="small"><strong>This will delete all existing phases and tasks and reimport from scratch. Are you sure?</strong></div>
          <div class="row" style="margin-top: 6px; gap: 8px;">
            <button id="importTasksConfirmYes" class="secondary" type="button">Yes, delete and reimport</button>
            <button id="importTasksConfirmNo" type="button">Cancel</button>
          </div>
        </div>
        <div id="importTasksStatus" class="small" style="margin-top: 8px;"></div>
        <div id="importTasksError" class="error"></div>
        <div id="syncTasksStatus" class="small" style="margin-top: 8px;"></div>
        <div id="syncTasksError" class="error"></div>
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
            <label class="small" for="globalDefaultRace">Default Race Count</label>
            <input id="globalDefaultRace" type="number" min="1" step="1" required />
            <label class="small" for="globalJudgeAdapter">Race Judge CLI</label>
            <select id="globalJudgeAdapter"></select>
            <label class="small" for="globalRaceJudgePrompt">Race Judge Extra Instructions</label>
            <textarea id="globalRaceJudgePrompt" rows="5" placeholder="Optional extra judging instructions"></textarea>
            <label class="small" for="globalRecoveryMaxAttempts">Exception Recovery Max Attempts</label>
            <input id="globalRecoveryMaxAttempts" type="number" min="0" max="10" step="1" required />
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
        <div class="small">Card order defines automatic failover priority for rate-limited tasks. Top to bottom wins.</div>
        <div id="adaptersSettingsList" style="display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));">
          <!-- Dynamically populated -->
        </div>
        <div class="row" style="margin-top: 16px;">
          <button id="saveAdaptersButton">Save Adapters Settings</button>
          <div id="adaptersSettingsStatus" class="small"></div>
        </div>
        <div id="adaptersSettingsError" class="error"></div>
      </section>

      <section class="card wide" style="margin-top: 16px;">
        <h2>Completion Gates</h2>
        <div class="small">Post-execution gates run in sequence after CI integration. Each gate must pass before the phase is marked ready for review.</div>
        <div id="gatesList" style="margin-top: 12px;"></div>
        <div class="row" style="margin-top: 12px; gap: 8px;">
          <select id="addGateType" style="width: auto;">
            <option value="command">Command</option>
            <option value="coverage">Coverage</option>
            <option value="ai_eval">AI Eval</option>
            <option value="pr_ci">PR CI</option>
          </select>
          <button id="addGateButton" type="button" class="secondary">+ Add Gate</button>
        </div>
        <div class="row" style="margin-top: 12px;">
          <button id="saveGatesButton">Save Gates</button>
          <div id="gatesSettingsStatus" class="small"></div>
        </div>
        <div id="gatesSettingsError" class="error"></div>
      </section>
    </div>

    <section class="card wide">
      <h2>Running Agents</h2>
      <div id="agentError" class="error"></div>
      <table id="agentTable">
        <thead>
          <tr><th>Project</th><th>Name</th><th>Status</th><th>PID</th><th>Task</th><th>Actions</th><th>Runtime</th></tr>
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
    const runtimeDefaultRace = document.getElementById("runtimeDefaultRace");
    const runtimeMaxTaskRetries = document.getElementById("runtimeMaxTaskRetries");
    const runtimePhaseTimeoutMs = document.getElementById("runtimePhaseTimeoutMs");
    const runtimeSettingsStatus = document.getElementById("runtimeSettingsStatus");
    const startAutoModeButton = document.getElementById("startAutoModeButton");
    const stopAutoModeButton = document.getElementById("stopAutoModeButton");
    const autoModeStatus = document.getElementById("autoModeStatus");
    const autoModeError = document.getElementById("autoModeError");
    const kanbanBoard = document.getElementById("kanbanBoard");
    const taskPhase = document.getElementById("taskPhase");
    const taskRace = document.getElementById("taskRace");
    const taskDependencies = document.getElementById("taskDependencies");
    const agentTopTableBody = document.querySelector("#agentTopTable tbody");
    const agentTableBody = document.querySelector("#agentTable tbody");
    const importTasksStatus = document.getElementById("importTasksStatus");
    const importTasksButton = document.getElementById("importTasksButton");
    const importTasksConfirm = document.getElementById("importTasksConfirm");
    const importTasksConfirmYes = document.getElementById("importTasksConfirmYes");
    const importTasksConfirmNo = document.getElementById("importTasksConfirmNo");
    const syncTasksButton = document.getElementById("syncTasksButton");
    const syncTasksStatus = document.getElementById("syncTasksStatus");
    const tabStrip = document.getElementById("tabStrip");
    const projectContent = document.getElementById("projectContent");
    const settingsContent = document.getElementById("settingsContent");
    const activePhaseBadge = document.getElementById("activePhaseBadge");

    const defaultInternalWorkAssignee = ${JSON.stringify(params.defaultInternalWorkAssignee)};
    const defaultAutoMode = ${params.defaultAutoMode};
    const defaultWebLogFilePath = ${JSON.stringify(params.webLogFilePath)};
    const defaultCliLogFilePath = ${JSON.stringify(params.cliLogFilePath)};
    const WORKER_ASSIGNEES = ${params.availableWorkerAssigneesJson};
    const INITIAL_PROJECT_NAME = ${JSON.stringify(params.projectName)};

    let latestAgents = [];
    let latestState = null;
    let latestRuntimeConfig = {
      defaultInternalWorkAssignee,
      autoMode: Boolean(defaultAutoMode),
      defaultRace: 1,
      maxTaskRetries: 3,
      phaseTimeoutMs: 21600000,
    };
    let projects = [];
    let activeProjectName = INITIAL_PROJECT_NAME;
    let isSettingsActive = false;
    const projectStateCache = new Map();
    let currentEventSource = null;
    let latestExecutionStatus = null;

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

    function updateAdapterPriorityLabels() {
      document.querySelectorAll("#adaptersSettingsList .card").forEach((card, index) => {
        const label = card.querySelector(".adapter-priority-label");
        if (label) {
          label.textContent = "Priority " + String(index + 1);
        }
      });
    }

    function moveAdapterCard(button) {
      const direction = button.getAttribute("data-move");
      const card = button.closest(".card");
      const list = document.getElementById("adaptersSettingsList");
      if (!card || !list || !direction) {
        return;
      }

      if (direction === "up" && card.previousElementSibling) {
        list.insertBefore(card, card.previousElementSibling);
      } else if (direction === "down" && card.nextElementSibling) {
        list.insertBefore(card.nextElementSibling, card);
      }
      updateAdapterPriorityLabels();
    }

    document.getElementById("adaptersSettingsList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-move]");
      if (!button) {
        return;
      }
      moveAdapterCard(button);
    });

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

    function summarizeFailureText(value) {
      const text = String(value || "").trim();
      if (!text) {
        return "No failure details available.";
      }

      const lines = text
        .split(/\\r?\\n/)
        .map((line) => line.replace(/\\s+/g, " ").trim())
        .filter((line) => line.length > 0);
      if (lines.length === 0) {
        return "No failure details available.";
      }

      const preferred =
        lines.find((line) =>
          /\\b(error|failed|exception|timeout|exit code|unauthorized|denied)\\b/i.test(line),
        ) || lines[0];
      if (preferred.length <= 140) {
        return preferred;
      }
      return preferred.slice(0, 137) + "...";
    }

    function parseOptionalPositiveInteger(value, fieldLabel) {
      const text = String(value ?? "").trim();
      if (!text) {
        return null;
      }

      const parsed = Number.parseInt(text, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(fieldLabel + " must be a positive integer.");
      }

      return parsed;
    }

    function toAnchorToken(raw) {
      return String(raw || "")
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "unknown";
    }

    function renderRecoveryLinks(links) {
      if (!Array.isArray(links) || links.length === 0) {
        return "";
      }

      return links
        .map((link) => {
          const label = escapeHtml(link && link.label ? link.label : "trace");
          const href = escapeHtml(link && link.href ? link.href : "#");
          return '<a class="mono small" href="' + href + '">' + label + "</a>";
        })
        .join(" | ");
    }

    function resolveTaskRaceCount(task) {
      if (task && Number.isInteger(task.race)) {
        return task.race;
      }
      return Number.isInteger(latestRuntimeConfig.defaultRace)
        ? latestRuntimeConfig.defaultRace
        : 1;
    }

    function renderTaskRaceState(task) {
      const effectiveRace = resolveTaskRaceCount(task);
      const usesDefaultRace = !(task && Number.isInteger(task.race));
      const raceState =
        task && task.raceState && typeof task.raceState === "object"
          ? task.raceState
          : null;
      const branches = Array.isArray(raceState && raceState.branches)
        ? raceState.branches
        : [];
      const branchSummary = branches.length
        ? '<div class="dep-list">' +
          branches
            .map((branch) => {
              const status = branch && typeof branch.status === "string"
                ? branch.status
                : "pending";
              const statusClass =
                status === "fulfilled" || status === "picked"
                  ? "dep-done"
                  : status === "rejected"
                    ? "dep-todo"
                    : "";
              const branchLabel =
                "#" +
                escapeHtml(String(branch.index)) +
                " " +
                escapeHtml(status);
              const branchTitleParts = [
                branch.branchName || "",
                branch.error || "",
              ].filter(Boolean);
              return (
                '<span class="dep-pill mono ' +
                statusClass +
                '" title="' +
                escapeHtml(branchTitleParts.join(" | ")) +
                '">' +
                branchLabel +
                "</span>"
              );
            })
            .join("") +
          "</div>"
        : "";
      const judgeSummary =
        raceState && raceState.judgeAdapter && raceState.pickedBranchIndex
          ? '<div class="small">Judge: <span class="mono">' +
            escapeHtml(raceState.judgeAdapter) +
            '</span> picked <span class="mono">#' +
            escapeHtml(String(raceState.pickedBranchIndex)) +
            '</span></div>'
          : "";
      const reasoningSummary =
        raceState && typeof raceState.reasoning === "string" && raceState.reasoning.trim()
          ? '<details><summary class="small">Judge reasoning</summary><div class="small">' +
            escapeHtml(raceState.reasoning) +
            "</div></details>"
          : "";
      const statusSummary =
        effectiveRace > 1 || raceState
          ? '<div class="small">Race: <span class="mono">' +
            escapeHtml(String(effectiveRace)) +
            "</span> (" +
            (usesDefaultRace ? "default" : "task override") +
            ")" +
            (raceState
              ? ' | Status: <span class="mono">' +
                escapeHtml(raceState.status) +
                "</span>"
              : "") +
            (raceState && Number.isInteger(raceState.commitCount)
              ? ' | Applied commits: <span class="mono">' +
                escapeHtml(String(raceState.commitCount)) +
                "</span>"
              : "") +
            "</div>"
          : "";

      return statusSummary + branchSummary + judgeSummary + reasoningSummary;
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
        await refreshRuntimeSettingsPanel();
        renderKanban(cached);
      }
      await refreshExecutionStatus();
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
        const globalJudgeSelect = document.getElementById("globalJudgeAdapter");
        globalAssigneeSelect.innerHTML = "";
        globalJudgeSelect.innerHTML = "";
        WORKER_ASSIGNEES.forEach((assignee) => {
          const option = document.createElement("option");
          option.value = assignee;
          option.textContent = assignee;
          option.selected = settings.internalWork?.assignee === assignee;
          globalAssigneeSelect.appendChild(option);
          const judgeOption = document.createElement("option");
          judgeOption.value = assignee;
          judgeOption.textContent = assignee;
          judgeOption.selected = settings.executionLoop?.judgeAdapter === assignee;
          globalJudgeSelect.appendChild(judgeOption);
        });
        document.getElementById("globalDefaultRace").value = String(
          settings.executionLoop?.defaultRace ?? 1,
        );
        document.getElementById("globalRaceJudgePrompt").value =
          settings.executionLoop?.raceJudgePrompt || "";
        const globalRecoveryMaxAttemptsInput = document.getElementById("globalRecoveryMaxAttempts");
        globalRecoveryMaxAttemptsInput.value = String(
          settings.exceptionRecovery?.maxAttempts ?? 1,
        );

        // Adapters
        const adaptersList = document.getElementById("adaptersSettingsList");
        adaptersList.innerHTML = "";
        const discoveredAgentIds = Object.keys(settings.agents || {}).filter((id) => {
          const config = settings.agents[id];
          return (
            config &&
            typeof config === "object" &&
            typeof config.enabled === "boolean" &&
            typeof config.timeoutMs === "number"
          );
        });
        const configuredPriority = Array.isArray(settings.executionLoop?.providerPriority)
          ? settings.executionLoop.providerPriority
          : [];
        const priorityIndex = new Map(
          configuredPriority.map((id, index) => [id, index]),
        );
        const agentIds = [...discoveredAgentIds].sort((left, right) => {
          const leftIndex = priorityIndex.has(left) ? priorityIndex.get(left) : Number.MAX_SAFE_INTEGER;
          const rightIndex = priorityIndex.has(right) ? priorityIndex.get(right) : Number.MAX_SAFE_INTEGER;
          if (leftIndex !== rightIndex) {
            return leftIndex - rightIndex;
          }
          return left.localeCompare(right);
        });
        agentIds.forEach(id => {
          const config = settings.agents[id];
          const div = document.createElement("div");
          div.className = "card";
          div.innerHTML = \`
            <div class="row" style="justify-content:space-between; align-items:flex-start;">
              <div>
                <h3 class="mono" style="margin-top:0; margin-bottom:4px;">\${id}</h3>
                <div class="small adapter-priority-label">Priority</div>
              </div>
              <div class="row">
                <button type="button" class="secondary" data-move="up">Up</button>
                <button type="button" class="secondary" data-move="down">Down</button>
              </div>
            </div>
            <label class="row small">
              <input type="checkbox" class="adapter-enabled" data-id="\${id}" \${config.enabled ? "checked" : ""}> Enabled
            </label>
            <label class="small" style="display:block; margin-top:8px;">Timeout (ms)</label>
            <input type="number" class="adapter-timeout" data-id="\${id}" value="\${config.timeoutMs}" style="width:100%;">
          \`;
          adaptersList.appendChild(div);
        });
        updateAdapterPriorityLabels();

        // Completion Gates
        renderGatesList(settings.executionLoop?.gates || []);
      } catch (error) {
        console.error("Failed to refresh settings:", error);
      }
    }

    let currentGates = [];

    function renderGatesList(gates) {
      currentGates = JSON.parse(JSON.stringify(gates));
      const container = document.getElementById("gatesList");
      container.innerHTML = "";
      if (currentGates.length === 0) {
        container.innerHTML = '<div class="small muted">No gates configured.</div>';
        return;
      }
      currentGates.forEach((gate, index) => {
        const div = document.createElement("div");
        div.className = "card";
        div.style.cssText = "margin-bottom: 8px; padding: 12px;";
        div.innerHTML = renderGateFields(gate, index);
        container.appendChild(div);
      });
    }

    function renderGateFields(gate, index) {
      const moveUp = index > 0 ? \`<button type="button" class="secondary small" onclick="moveGate(\${index}, -1)">↑</button>\` : "";
      const moveDown = index < currentGates.length - 1 ? \`<button type="button" class="secondary small" onclick="moveGate(\${index}, 1)">↓</button>\` : "";
      const header = \`<div class="row" style="justify-content: space-between; margin-bottom: 8px;">
        <strong class="mono">#\${index + 1} \${gate.type}</strong>
        <div class="row" style="gap: 4px;">\${moveUp}\${moveDown}<button type="button" class="secondary small" onclick="removeGate(\${index})">Remove</button></div>
      </div>\`;

      let fields = "";
      switch (gate.type) {
        case "command":
          fields = \`
            <label class="small">Command</label>
            <input class="gate-field" data-index="\${index}" data-key="command" value="\${escAttr(gate.command || "")}" style="width:100%;">
            <label class="small" style="margin-top:6px; display:block;">Args (comma-separated)</label>
            <input class="gate-field" data-index="\${index}" data-key="args" value="\${escAttr((gate.args || []).join(", "))}" style="width:100%;">
            <label class="small" style="margin-top:6px; display:block;">Timeout (ms)</label>
            <input type="number" class="gate-field" data-index="\${index}" data-key="timeoutMs" value="\${gate.timeoutMs || ""}" style="width:100%;">
          \`;
          break;
        case "coverage":
          fields = \`
            <label class="small">Report Path</label>
            <input class="gate-field" data-index="\${index}" data-key="reportPath" value="\${escAttr(gate.reportPath || "")}" style="width:100%;">
            <label class="small" style="margin-top:6px; display:block;">Min Coverage %</label>
            <input type="number" class="gate-field" data-index="\${index}" data-key="minPct" value="\${gate.minPct ?? ""}" min="0" max="100" style="width:100%;">
            <label class="small" style="margin-top:6px; display:block;">Format</label>
            <select class="gate-field" data-index="\${index}" data-key="format" style="width:100%;">
              <option value="">Auto-detect</option>
              <option value="lcov" \${gate.format === "lcov" ? "selected" : ""}>lcov</option>
              <option value="json" \${gate.format === "json" ? "selected" : ""}>JSON</option>
              <option value="cobertura" \${gate.format === "cobertura" ? "selected" : ""}>Cobertura</option>
            </select>
          \`;
          break;
        case "ai_eval":
          fields = \`
            <label class="small">Command</label>
            <input class="gate-field" data-index="\${index}" data-key="command" value="\${escAttr(gate.command || "")}" style="width:100%;">
            <label class="small" style="margin-top:6px; display:block;">Args (comma-separated)</label>
            <input class="gate-field" data-index="\${index}" data-key="args" value="\${escAttr((gate.args || []).join(", "))}" style="width:100%;">
            <label class="small" style="margin-top:6px; display:block;">Rubric</label>
            <textarea class="gate-field" data-index="\${index}" data-key="rubric" rows="3" style="width:100%;">\${escAttr(gate.rubric || "")}</textarea>
            <label class="small" style="margin-top:6px; display:block;">Pass Keywords (comma-separated)</label>
            <input class="gate-field" data-index="\${index}" data-key="passKeywords" value="\${escAttr((gate.passKeywords || []).join(", "))}" style="width:100%;">
            <label class="small" style="margin-top:6px; display:block;">Fail Keywords (comma-separated)</label>
            <input class="gate-field" data-index="\${index}" data-key="failKeywords" value="\${escAttr((gate.failKeywords || []).join(", "))}" style="width:100%;">
            <label class="small" style="margin-top:6px; display:block;">Max Retries</label>
            <input type="number" class="gate-field" data-index="\${index}" data-key="maxRetries" value="\${gate.maxRetries ?? ""}" min="0" max="10" style="width:100%;">
            <label class="small" style="margin-top:6px; display:block;">Timeout (ms)</label>
            <input type="number" class="gate-field" data-index="\${index}" data-key="timeoutMs" value="\${gate.timeoutMs || ""}" style="width:100%;">
          \`;
          break;
        case "pr_ci":
          fields = \`
            <label class="small">Poll Interval (ms)</label>
            <input type="number" class="gate-field" data-index="\${index}" data-key="intervalMs" value="\${gate.intervalMs || ""}" style="width:100%;">
            <label class="small" style="margin-top:6px; display:block;">Timeout (ms)</label>
            <input type="number" class="gate-field" data-index="\${index}" data-key="timeoutMs" value="\${gate.timeoutMs || ""}" style="width:100%;">
            <label class="small" style="margin-top:6px; display:block;">Terminal Confirmations</label>
            <input type="number" class="gate-field" data-index="\${index}" data-key="terminalConfirmations" value="\${gate.terminalConfirmations ?? ""}" min="1" max="10" style="width:100%;">
          \`;
          break;
      }
      return header + fields;
    }

    function escAttr(str) {
      return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    window.moveGate = function(index, direction) {
      const target = index + direction;
      if (target < 0 || target >= currentGates.length) return;
      collectGateFieldValues();
      const temp = currentGates[index];
      currentGates[index] = currentGates[target];
      currentGates[target] = temp;
      renderGatesList(currentGates);
    };

    window.removeGate = function(index) {
      collectGateFieldValues();
      currentGates.splice(index, 1);
      renderGatesList(currentGates);
    };

    function collectGateFieldValues() {
      document.querySelectorAll(".gate-field").forEach(input => {
        const idx = parseInt(input.getAttribute("data-index"), 10);
        const key = input.getAttribute("data-key");
        const gate = currentGates[idx];
        if (!gate) return;
        const val = input.value.trim();
        if (key === "args" || key === "passKeywords" || key === "failKeywords") {
          gate[key] = val ? val.split(",").map(s => s.trim()).filter(Boolean) : undefined;
        } else if (key === "timeoutMs" || key === "intervalMs" || key === "minPct" || key === "maxRetries" || key === "terminalConfirmations") {
          gate[key] = val ? Number(val) : undefined;
        } else if (key === "format") {
          gate[key] = val || undefined;
        } else {
          gate[key] = val;
        }
      });
    }

    async function refreshProjects() {
      try {
        const loadedProjects = await api("/api/projects");
        projects = Array.isArray(loadedProjects) ? loadedProjects : [];
        if (projects.length === 0) {
          projects = [{ name: activeProjectName || INITIAL_PROJECT_NAME, rootDir: "" }];
        }
        if (!projects.some((project) => project.name === activeProjectName)) {
          activeProjectName = projects[0].name;
        }
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
        await refreshRuntimeSettingsPanel();
        renderKanban(state);
        await refreshExecutionStatus();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setError("kanbanError", message);
        setError("runtimeSettingsError", message);
      }
    }

    function resolveProjectRuntimeConfig(project, settings) {
      return {
        autoMode:
          project && project.executionSettings && typeof project.executionSettings.autoMode === "boolean"
            ? project.executionSettings.autoMode
            : !!settings.executionLoop?.autoMode,
        defaultInternalWorkAssignee:
          project && project.executionSettings && project.executionSettings.defaultAssignee
            ? project.executionSettings.defaultAssignee
            : settings.internalWork?.assignee ?? defaultInternalWorkAssignee,
        defaultRace:
          project && project.executionSettings && Number.isInteger(project.executionSettings.defaultRace)
            ? project.executionSettings.defaultRace
            : settings.executionLoop?.defaultRace ?? latestRuntimeConfig.defaultRace,
        maxTaskRetries:
          project && project.executionSettings && Number.isInteger(project.executionSettings.maxTaskRetries)
            ? project.executionSettings.maxTaskRetries
            : settings.executionLoop?.maxTaskRetries ?? latestRuntimeConfig.maxTaskRetries,
        phaseTimeoutMs:
          project && project.executionSettings && Number.isInteger(project.executionSettings.phaseTimeoutMs)
            ? project.executionSettings.phaseTimeoutMs
            : settings.executionLoop?.phaseTimeoutMs ?? latestRuntimeConfig.phaseTimeoutMs,
      };
    }

    async function refreshRuntimeSettingsPanel() {
      const settings = await api("/api/settings");
      const project = projects.find((candidate) => candidate.name === activeProjectName);
      renderRuntimeConfig(resolveProjectRuntimeConfig(project, settings));
    }

    function resolveActivePhases(state) {
      const phasesById = new Map(state.phases.map((phase) => [phase.id, phase]));
      const activePhases = [];
      const seen = new Set();
      (state.activePhaseIds || []).forEach((rawPhaseId) => {
        const phaseId =
          typeof rawPhaseId === "string" ? rawPhaseId.trim() : "";
        if (!phaseId || seen.has(phaseId)) {
          return;
        }
        const phase = phasesById.get(phaseId);
        if (!phase) {
          return;
        }
        seen.add(phaseId);
        activePhases.push(phase);
      });
      return activePhases;
    }

    function formatActivePhaseStatus(state) {
      const activePhases = resolveActivePhases(state);
      if (activePhases.length === 0) {
        return "No active phases";
      }
      return activePhases
        .map((phase) => phase.name + " (" + phase.status + ")")
        .join(" | ");
    }

    function renderState(state) {
      latestState = state;
      const activePhases = resolveActivePhases(state);
      const selectedPhaseId = activePhases[0] ? activePhases[0].id : undefined;
      if (activePhases.length === 0 && state.phases.length > 0) {
        console.warn(
          "Active phase IDs are missing or invalid. Set active phases explicitly.",
        );
      }
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
      if (activePhaseBadge) {
        activePhaseBadge.textContent = formatActivePhaseStatus(state);
      }
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
      if (runtimeDefaultRace instanceof HTMLInputElement) {
        runtimeDefaultRace.value = String(config.defaultRace);
      }
      if (runtimeMaxTaskRetries instanceof HTMLInputElement) {
        runtimeMaxTaskRetries.value = String(config.maxTaskRetries);
      }
      if (runtimePhaseTimeoutMs instanceof HTMLInputElement) {
        runtimePhaseTimeoutMs.value = String(config.phaseTimeoutMs);
      }
      if (runtimeSettingsStatus) {
        runtimeSettingsStatus.textContent =
          "Mode: " +
          (config.autoMode ? "Auto" : "Manual") +
          " | Default CLI: " +
          config.defaultInternalWorkAssignee +
          " | Default race: " +
          config.defaultRace +
          " | Max task retries: " +
          config.maxTaskRetries +
          " | Phase timeout: " +
          config.phaseTimeoutMs +
          " ms";
      }
    }

    function setAutoModeStatus(message) {
      if (autoModeStatus instanceof HTMLElement) {
        autoModeStatus.textContent = message || "";
      }
    }

    function setAutoModeError(message) {
      if (autoModeError instanceof HTMLElement) {
        autoModeError.textContent = message || "";
      }
    }

    function syncAutoModeButtons() {
      const isRunning = Boolean(latestExecutionStatus && latestExecutionStatus.running);
      if (startAutoModeButton instanceof HTMLButtonElement) {
        startAutoModeButton.disabled = isRunning;
      }
      if (stopAutoModeButton instanceof HTMLButtonElement) {
        stopAutoModeButton.disabled = !isRunning;
      }
    }

    function renderExecutionStatus(status) {
      latestExecutionStatus = status;
      const projectPrefix =
        status && status.projectName
          ? "[" + status.projectName + "] "
          : "";
      const message =
        status && typeof status.message === "string"
          ? status.message
          : "Auto mode is idle.";
      setAutoModeStatus(projectPrefix + message);
      syncAutoModeButtons();
    }

    async function refreshExecutionStatus() {
      try {
        const status = await api(
          "/api/execution?projectName=" + encodeURIComponent(activeProjectName),
        );
        renderExecutionStatus(status);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setAutoModeError(message);
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
      const KANBAN_STATUSES = ["TODO", "IN_PROGRESS", "DONE", "FAILED", "DEAD_LETTER"];
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

      const activePhaseIds = new Set(
        resolveActivePhases(state).map((phase) => phase.id),
      );
      if (activePhaseIds.size === 0) {
        console.warn(
          "Kanban has no valid active phases. Use Set Active to choose one.",
        );
      }
      const html = state.phases.map((phase) => {
        const isActive = activePhaseIds.has(phase.id);
        if (!isActive) {
          const tasks = phase.tasks || [];
          if (tasks.length === 0) return ""; // hide phases with no tasks
          const phaseDiagnosticSummary = phase.ciStatusContext
            ? summarizeFailureText(phase.ciStatusContext)
            : "";
          const taskPills = tasks.map((task) => {
            const s = task.status;
            const cls = s === "DONE" ? "pill-done"
              : s === "FAILED" || s === "DEAD_LETTER" ? "pill-failed"
              : s === "IN_PROGRESS" || s === "CI_FIX" ? "pill-inprogress"
              : "pill-todo";
            return '<span class="phase-task-pill ' + cls + '" title="' + escapeHtml(s) + '">' + escapeHtml(task.title) + '</span>';
          }).join("");
          const doneTasks = tasks.filter(t => t.status === "DONE").length;
          const allDone = doneTasks === tasks.length;
          const effectiveStatus = allDone ? "DONE"
            : (phase.status === "PLANNING" && doneTasks > 0) ? "PARTIAL"
            : phase.status;
          const isCompleted = allDone || phase.status === "DONE" || phase.status === "READY_FOR_REVIEW";
          const summary = escapeHtml(effectiveStatus) + " | " + doneTasks + "/" + tasks.length + " done";
          return (
            '<section class="phase-row" data-phase-id="' + escapeHtml(phase.id) + '">' +
              '<div class="phase-collapsed">' +
                "<div>" +
                  "<h3>" + escapeHtml(phase.name) + " <span class='phase-expand-arrow'>▶</span></h3>" +
                  '<div class="small mono muted">' + summary + "</div>" +
                  (phaseDiagnosticSummary
                    ? '<div class="small error" title="' + escapeHtml(phase.ciStatusContext) + '">' + escapeHtml(phaseDiagnosticSummary) + "</div>"
                    : "") +
                  (phase.prUrl ? '<div class="small"><a href="' + escapeHtml(phase.prUrl) + '" target="_blank" rel="noopener">PR: ' + escapeHtml(phase.prUrl) + '</a></div>' : "") +
                "</div>" +
                (isCompleted ? "" :
                  '<button type="button" class="secondary phase-activate-button" data-phase-id="' + escapeHtml(phase.id) + '">Set Active</button>') +
              "</div>" +
              '<div class="phase-expand-tasks">' + taskPills + '</div>' +
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
                const dependencyOptionsHtml = state.phases.map((candidatePhase) => {
                  return (candidatePhase.tasks || []).map((candidateTask, index) => {
                    if (candidateTask.id === task.id) {
                      return "";
                    }
                    const selected = (task.dependencies || []).includes(candidateTask.id)
                      ? " selected"
                      : "";
                    const label =
                      candidatePhase.name +
                      " :: " +
                      (index + 1) +
                      ". [" +
                      candidateTask.status +
                      "] " +
                      candidateTask.title;
                    return (
                      '<option value="' +
                      escapeHtml(candidateTask.id) +
                      '"' +
                      selected +
                      ">" +
                      escapeHtml(label) +
                      "</option>"
                    );
                  }).join("");
                }).join("");
                const editDisabled = task.status === "IN_PROGRESS";
                const taskRaceValue = Number.isInteger(task.race) ? task.race : null;
                const raceDetailsHtml = renderTaskRaceState(task);

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

                const recoveryAttempts = Array.isArray(task.recoveryAttempts)
                  ? task.recoveryAttempts
                  : [];
                const latestRecovery =
                  recoveryAttempts.length > 0
                    ? recoveryAttempts[recoveryAttempts.length - 1]
                    : null;
                const taskAnchor = toAnchorToken(task.id);
                const failureSummary = summarizeFailureText(task.errorLogs);
                const retrySummary = task.rateLimitRetryAt
                  ? "Rate-limit retry " +
                    (typeof task.rateLimitRetryCount === "number"
                      ? "#" + task.rateLimitRetryCount
                      : "scheduled") +
                    " at " +
                    task.rateLimitRetryAt
                  : "";
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
                    const recoveryHistoryId = "task-recovery-" + taskAnchor;
                    const latestAttemptNumber =
                      latestRecovery && Number.isInteger(latestRecovery.attemptNumber)
                        ? latestRecovery.attemptNumber
                        : recoveryAttempts.length;
                    const latestRecoveryId = recoveryHistoryId + "-" + latestAttemptNumber;
                    return (
                      '<div class="small">Retry Agent: <span class="mono">' + escapeHtml(retryAssignee || "UNASSIGNED") + "</span></div>" +
                      '<div class="small">Failure summary: <span class="mono">' + escapeHtml(failureSummary) + "</span></div>" +
                      '<div class="row">' +
                        '<button type="button" class="secondary task-run-button" data-phase-id="' + escapeHtml(phase.id) + '" data-task-id="' + escapeHtml(task.id) + '" data-assignee="' + escapeHtml(retryAssignee) + '"' + (hasUnfinishedDependency || !retryAssignee ? " disabled" : "") + '>Retry</button>' +
                        '<button type="button" class="secondary task-reset-button" data-phase-id="' + escapeHtml(phase.id) + '" data-task-id="' + escapeHtml(task.id) + '">Reset TODO</button>' +
                      "</div>" +
                      '<details><summary class="small">Failure logs</summary><pre class="mono small">' + escapeHtml(task.errorLogs || "No logs available.") + "</pre></details>" +
                      (recoveryAttempts.length > 0
                        ? '<details id="' + escapeHtml(recoveryHistoryId) + '"><summary class="small">Recovery trace history</summary>' +
                          recoveryAttempts.map((attempt) => {
                            const attemptNumber =
                              Number.isInteger(attempt.attemptNumber) && attempt.attemptNumber > 0
                                ? attempt.attemptNumber
                                : 0;
                            const attemptId = recoveryHistoryId + "-" + attemptNumber;
                            return (
                              '<div id="' +
                              escapeHtml(attemptId) +
                              '" class="small mono" style="margin-top:6px;">' +
                              "attempt " +
                              escapeHtml(String(attemptNumber)) +
                              ": " +
                              escapeHtml((attempt.result && attempt.result.status) || "unknown") +
                              " - " +
                              escapeHtml((attempt.result && attempt.result.reasoning) || "") +
                              "</div>"
                            );
                          }).join("") +
                          (latestRecovery
                            ? '<div class="small">Latest trace: <a class="mono" href="#' + escapeHtml(latestRecoveryId) + '">attempt ' + escapeHtml(String(latestAttemptNumber)) + "</a></div>"
                            : "") +
                          "</details>"
                        : "") +
                      (hasUnfinishedDependency
                        ? '<div class="small" style="color:#7a2618;">Cannot retry until all dependencies are DONE.</div>'
                        : "") +
                      (!retryAssignee
                        ? '<div class="small" style="color:#7a2618;">Cannot retry without previous assignee. Reset to TODO and assign an agent.</div>'
                        : "") +
                      '<div class="error task-run-error"></div>'
                    );
                  }

                  if (task.status === "DEAD_LETTER") {
                    return (
                      '<div class="small">Dead-lettered after unfixable recovery.</div>' +
                      '<div class="small">Remediation: <span class="mono">' +
                        escapeHtml(task.resultContext || "Manual remediation required. Reset to TODO once fixed.") +
                      "</span></div>" +
                      '<div class="small">Failure summary: <span class="mono">' + escapeHtml(failureSummary) + "</span></div>" +
                      '<div class="row">' +
                        '<button type="button" class="secondary task-reset-button" data-phase-id="' + escapeHtml(phase.id) + '" data-task-id="' + escapeHtml(task.id) + '">Reset TODO</button>' +
                      "</div>" +
                      '<details><summary class="small">Failure logs</summary><pre class="mono small">' + escapeHtml(task.errorLogs || "No logs available.") + "</pre></details>" +
                      '<div class="error task-run-error"></div>'
                    );
                  }

                  return '<div class="small">Assigned Agent: <span class="mono">' + escapeHtml(task.assignee) + "</span></div>";
                })();

                return (
                  '<div class="task-card" id="task-card-' + escapeHtml(taskAnchor) + '">' +
                    '<button type="button" class="secondary task-edit-toggle-button task-edit-corner" title="Edit task" data-phase-id="' + escapeHtml(phase.id) + '" data-task-id="' + escapeHtml(task.id) + '"' + (editDisabled ? " disabled" : "") + '>&#9998;</button>' +
                    '<div class="task-view-inline">' +
                      '<div><strong>' + escapeHtml(task.title) + '</strong></div>' +
                      '<div class="small">' + escapeHtml(task.description) + '</div>' +
                      '<div class="small">Status: <span class="mono">' + escapeHtml(task.status) + '</span> | Worker: <span class="mono">' + escapeHtml(task.assignee) + "</span>" +
                        (latestRecovery
                          ? ' <span class="pill" title="' + escapeHtml(latestRecovery.result.reasoning || "") + '">! recovery ' + escapeHtml(latestRecovery.result.status || "unknown") + '</span>'
                          : "") +
                      "</div>" +
                      (latestRecovery
                        ? '<div class="small">Recovery: <span class="mono">' + escapeHtml(latestRecovery.result.status || "unknown") + '</span> - ' + escapeHtml(latestRecovery.result.reasoning || "") + "</div>"
                        : "") +
                      (retrySummary
                        ? '<div class="small">Retry: <span class="mono">' + escapeHtml(retrySummary) + "</span></div>"
                        : "") +
                      '<div class="small">Dependencies:</div>' +
                      '<div class="dep-list">' + depsHtml + "</div>" +
                      raceDetailsHtml +
                      (editDisabled
                        ? '<div class="small muted">Editing disabled while task is IN_PROGRESS.</div>'
                        : "") +
                    "</div>" +
                    '<div class="task-edit-inline hidden">' +
                      '<label class="small">Title</label>' +
                      '<input class="task-edit-title" value="' + escapeHtml(task.title) + '" />' +
                      '<label class="small">Description</label>' +
                      '<textarea class="task-edit-description" rows="3">' + escapeHtml(task.description) + "</textarea>" +
                      '<label class="small">Race Count Override</label>' +
                      '<input class="task-edit-race" type="number" min="1" step="1" placeholder="Use default race count" value="' + escapeHtml(taskRaceValue === null ? "" : String(taskRaceValue)) + '" />' +
                      '<label class="small">Dependencies</label>' +
                      '<select class="task-edit-dependencies" multiple size="6">' + dependencyOptionsHtml + "</select>" +
                      '<div class="row">' +
                        '<button type="button" class="secondary task-edit-save-button" data-phase-id="' + escapeHtml(phase.id) + '" data-task-id="' + escapeHtml(task.id) + '">Save</button>' +
                        '<button type="button" class="secondary task-edit-cancel-button">Cancel</button>' +
                      "</div>" +
                      '<div class="error task-edit-error"></div>' +
                    "</div>" +
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
              '<div>' +
                "<h3>" + escapeHtml(phase.name) + "</h3>" +
                (phase.ciStatusContext
                  ? '<div class="small error" title="' + escapeHtml(phase.ciStatusContext) + '">' + escapeHtml(summarizeFailureText(phase.ciStatusContext)) + "</div>"
                  : "") +
              "</div>" +
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

    const AGENT_LIST_LIMIT = 5;

    function renderAgentRow(agent) {
      const projectName = agent.projectName || "-";
      const taskName = (() => {
        if (agent.taskTitle && Number.isInteger(agent.taskNumber)) {
          const phaseLabel = agent.phaseName ? agent.phaseName + " " : "";
          return phaseLabel + "#" + agent.taskNumber + " " + agent.taskTitle;
        }
        return agent.taskId === undefined || agent.taskId === null ? "-" : agent.taskId;
      })();
      const pid = agent.pid === undefined || agent.pid === null ? "-" : agent.pid;
      const runtimeSummary = (() => {
        const summary = agent.runtimeDiagnostic && typeof agent.runtimeDiagnostic.summary === "string"
          ? agent.runtimeDiagnostic.summary
          : "";
        if (summary) {
          return summary;
        }
        return (agent.outputTail || []).slice(-3).map(truncateTailPreview).join(" | ");
      })();
      return { projectName, taskName, pid, runtimeSummary };
    }

    function renderAgents(agents) {
      latestAgents = agents;
      agentTableBody.innerHTML = "";
      agentTopTableBody.innerHTML = "";

      // Per-project Running Agents: filter to active project, cap to most recent 5.
      const projectAgents = agents
        .filter(a => (a.projectName || null) === activeProjectName)
        .slice(0, AGENT_LIST_LIMIT);

      projectAgents.forEach((agent) => {
        const { projectName, taskName, pid, runtimeSummary } = renderAgentRow(agent);
        const row = document.createElement("tr");
        row.innerHTML = \`
          <td>\${escapeHtml(projectName)}</td>
          <td>\${escapeHtml(agent.name)}<div class="small mono">\${escapeHtml(agent.command)} \${escapeHtml(agent.args.join(" "))}</div></td>
          <td>\${escapeHtml(agent.status)}\${agent.recoveryAttempted ? ' <span class="pill" title="' + escapeHtml(agent.recoveryReasoning || "") + '">!</span>' : ''}</td>
          <td>\${escapeHtml(String(pid))}</td>
          <td class="mono">\${escapeHtml(String(taskName))}</td>
          <td>
            <div class="row">
              <button data-action="show-logs" data-id="\${escapeHtml(agent.id)}" class="secondary">Logs</button>
              <button data-action="kill" data-id="\${escapeHtml(agent.id)}" class="secondary">Kill</button>
              <button data-action="restart" data-id="\${escapeHtml(agent.id)}" class="secondary">Restart</button>
            </div>
          </td>
          <td><div class="mono small">\${escapeHtml(runtimeSummary || "-")}</div></td>
        \`;
        agentTableBody.appendChild(row);
      });

      // Global Agents: top 5 most recent across all projects (API already returns sorted by recency).
      const globalAgents = agents.slice(0, AGENT_LIST_LIMIT);

      globalAgents.forEach((agent) => {
        const { projectName, taskName, pid, runtimeSummary } = renderAgentRow(agent);
        const topRow = document.createElement("tr");
        topRow.innerHTML = \`
          <td>\${escapeHtml(projectName)}</td>
          <td title="\${escapeHtml(agent.command)} \${escapeHtml(agent.args.join(" "))}">\${escapeHtml(agent.name)}</td>
          <td class="mono">\${escapeHtml(String(taskName))}</td>
          <td>\${escapeHtml(agent.status)}\${agent.recoveryAttempted ? ' <span class="pill" title="' + escapeHtml(agent.recoveryReasoning || "") + '">!</span>' : ''}</td>
          <td>\${escapeHtml(String(pid))}</td>
          <td><div class="mono small">\${escapeHtml(runtimeSummary || "-")}</div></td>
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
      const [agentsResult, usageResult] = await Promise.allSettled([
        api("/api/agents", {}, 3000),
        api("/api/usage", {}, 3000),
      ]);

      if (agentsResult.status === "fulfilled") {
        renderAgents(agentsResult.value);
      } else {
        throw agentsResult.reason;
      }

      if (usageResult.status === "fulfilled") {
        const usage = usageResult.value;
        usageStatus.textContent = usage.available ? "Available" : ("Unavailable: " + (usage.message || "unknown"));
        usageRaw.textContent = usage.snapshot ? JSON.stringify(usage.snapshot.payload, null, 2) : "";
      } else {
        usageStatus.textContent = "Unavailable: failed to load usage snapshot.";
        usageRaw.textContent = "";
      }
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
        const defaultRaceValue =
          runtimeDefaultRace instanceof HTMLInputElement
            ? Number.parseInt(runtimeDefaultRace.value, 10)
            : latestRuntimeConfig.defaultRace;
        if (!Number.isInteger(defaultRaceValue) || defaultRaceValue <= 0) {
          throw new Error("Default race count must be a positive integer.");
        }
        const maxTaskRetriesValue =
          runtimeMaxTaskRetries instanceof HTMLInputElement
            ? Number.parseInt(runtimeMaxTaskRetries.value, 10)
            : latestRuntimeConfig.maxTaskRetries;
        if (
          !Number.isInteger(maxTaskRetriesValue) ||
          maxTaskRetriesValue < 0 ||
          maxTaskRetriesValue > 20
        ) {
          throw new Error("Max task retries must be an integer between 0 and 20.");
        }
        const phaseTimeoutMsValue =
          runtimePhaseTimeoutMs instanceof HTMLInputElement
            ? Number.parseInt(runtimePhaseTimeoutMs.value, 10)
            : latestRuntimeConfig.phaseTimeoutMs;
        if (
          !Number.isInteger(phaseTimeoutMsValue) ||
          phaseTimeoutMsValue <= 0
        ) {
          throw new Error("Phase timeout must be a positive integer in milliseconds.");
        }

        await api("/api/projects/" + encodeURIComponent(activeProjectName) + "/settings", {
          method: "PATCH",
          body: JSON.stringify({
            autoMode: modeValue === "auto",
            defaultAssignee: assigneeValue,
            defaultRace: defaultRaceValue,
            maxTaskRetries: maxTaskRetriesValue,
            phaseTimeoutMs: phaseTimeoutMsValue,
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

    if (startAutoModeButton instanceof HTMLButtonElement) {
      startAutoModeButton.addEventListener("click", async () => {
        setAutoModeError("");
        try {
          const status = await api("/api/execution/start", {
            method: "POST",
            body: JSON.stringify({ projectName: activeProjectName }),
          });
          renderExecutionStatus(status);
          await refreshActiveProject();
          await globalRefresh().catch(handleRefreshError);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setAutoModeError(message);
        }
      });
    }

    if (stopAutoModeButton instanceof HTMLButtonElement) {
      stopAutoModeButton.addEventListener("click", async () => {
        setAutoModeError("");
        try {
          const status = await api("/api/execution/stop", {
            method: "POST",
            body: JSON.stringify({ projectName: activeProjectName }),
          });
          renderExecutionStatus(status);
          await refreshActiveProject();
          await globalRefresh().catch(handleRefreshError);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setAutoModeError(message);
        }
      });
    }

    document.getElementById("taskForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      setError("taskError", "");
      try {
        const dependencies =
          taskDependencies instanceof HTMLSelectElement
            ? Array.from(taskDependencies.selectedOptions).map((option) => option.value).filter(Boolean)
            : [];
        const raceValue =
          taskRace instanceof HTMLInputElement
            ? parseOptionalPositiveInteger(taskRace.value, "Race count override")
            : null;
        await api("/api/tasks", {
          method: "POST",
          body: JSON.stringify({
            projectName: activeProjectName,
            phaseId: document.getElementById("taskPhase").value,
            title: document.getElementById("taskTitle").value,
            description: document.getElementById("taskDescription").value,
            race: raceValue === null ? undefined : raceValue,
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

    importTasksButton.addEventListener("click", () => {
      setError("importTasksError", "");
      importTasksStatus.textContent = "";
      importTasksConfirm.style.display = "block";
      importTasksButton.disabled = true;
      syncTasksButton.disabled = true;
    });

    importTasksConfirmNo.addEventListener("click", () => {
      importTasksConfirm.style.display = "none";
      importTasksButton.disabled = false;
      syncTasksButton.disabled = false;
    });

    importTasksConfirmYes.addEventListener("click", async () => {
      importTasksConfirm.style.display = "none";
      const startedAt = Date.now();
      importTasksStatus.textContent = "Importing... 0s";
      await globalRefresh().catch(handleRefreshError);
      const ticker = setInterval(() => {
        const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
        importTasksStatus.textContent = "Importing... " + elapsedSeconds + "s";
      }, 1000);
      const agentTicker = setInterval(() => {
        globalRefresh().catch(handleRefreshError);
      }, 1000);
      try {
        const result = await api("/api/import/tasks-md", {
          method: "POST",
          body: JSON.stringify({
            projectName: activeProjectName,
            assignee: latestRuntimeConfig.defaultInternalWorkAssignee,
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
        await globalRefresh();
      } catch (error) {
        importTasksStatus.textContent = "";
        setError("importTasksError", error instanceof Error ? error.message : String(error));
      } finally {
        clearInterval(ticker);
        clearInterval(agentTicker);
        importTasksButton.disabled = false;
        syncTasksButton.disabled = false;
      }
    });

    syncTasksButton.addEventListener("click", async () => {
      setError("syncTasksError", "");
      syncTasksStatus.textContent = "Syncing...";
      syncTasksButton.disabled = true;
      importTasksButton.disabled = true;
      try {
        const result = await api("/api/sync/tasks-md", {
          method: "POST",
          body: JSON.stringify({ projectName: activeProjectName }),
        });
        syncTasksStatus.textContent =
          "Synced from " +
          result.sourceFilePath +
          ": +" +
          result.addedPhases +
          " phases, +" +
          result.addedTasks +
          " tasks, " +
          result.updatedTasks +
          " updated.";
        await refreshActiveProject();
        await globalRefresh();
      } catch (error) {
        syncTasksStatus.textContent = "";
        setError("syncTasksError", error instanceof Error ? error.message : String(error));
      } finally {
        syncTasksButton.disabled = false;
        importTasksButton.disabled = false;
      }
    });

    kanbanBoard.addEventListener("click", async (event) => {
      const target = event.target;
      // Toggle expand on collapsed phase rows (click anywhere except buttons)
      if (!(target instanceof HTMLButtonElement)) {
        const row = target instanceof Element ? target.closest(".phase-row") : null;
        if (row && row.querySelector(".phase-collapsed")) {
          row.classList.toggle("expanded");
        }
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

      if (target.classList.contains("task-edit-toggle-button")) {
        const taskCard = target.closest(".task-card");
        const viewPanel = taskCard ? taskCard.querySelector(".task-view-inline") : null;
        const editPanel = taskCard ? taskCard.querySelector(".task-edit-inline") : null;
        const editError = taskCard ? taskCard.querySelector(".task-edit-error") : null;
        if (!(editPanel instanceof HTMLElement)) {
          return;
        }
        if (!(viewPanel instanceof HTMLElement)) {
          return;
        }

        setError("kanbanError", "");
        if (editError instanceof HTMLElement) {
          editError.textContent = "";
        }
        const isHidden = editPanel.classList.contains("hidden");
        editPanel.classList.toggle("hidden", !isHidden);
        viewPanel.classList.toggle("hidden", isHidden);
        return;
      }

      if (target.classList.contains("task-edit-cancel-button")) {
        const taskCard = target.closest(".task-card");
        const viewPanel = taskCard ? taskCard.querySelector(".task-view-inline") : null;
        const editPanel = taskCard ? taskCard.querySelector(".task-edit-inline") : null;
        const editError = taskCard ? taskCard.querySelector(".task-edit-error") : null;
        if (editError instanceof HTMLElement) {
          editError.textContent = "";
        }
        if (viewPanel instanceof HTMLElement) {
          viewPanel.classList.remove("hidden");
        }
        if (editPanel instanceof HTMLElement) {
          editPanel.classList.add("hidden");
        }
        return;
      }

      if (target.classList.contains("task-edit-save-button")) {
        const taskId = target.getAttribute("data-task-id") || "";
        const phaseId = target.getAttribute("data-phase-id") || "";
        const taskCard = target.closest(".task-card");
        const titleInput = taskCard ? taskCard.querySelector(".task-edit-title") : null;
        const descriptionInput = taskCard ? taskCard.querySelector(".task-edit-description") : null;
        const raceInput = taskCard ? taskCard.querySelector(".task-edit-race") : null;
        const dependenciesSelect = taskCard ? taskCard.querySelector(".task-edit-dependencies") : null;
        const editError = taskCard ? taskCard.querySelector(".task-edit-error") : null;
        if (!phaseId || !taskId) {
          return;
        }
        if (!(titleInput instanceof HTMLInputElement)) {
          return;
        }
        if (!(descriptionInput instanceof HTMLTextAreaElement)) {
          return;
        }

        const dependencies =
          dependenciesSelect instanceof HTMLSelectElement
            ? Array.from(dependenciesSelect.selectedOptions)
                .map((option) => option.value)
                .filter(Boolean)
            : [];
        const raceValue =
          raceInput instanceof HTMLInputElement
            ? parseOptionalPositiveInteger(raceInput.value, "Race count override")
            : null;

        setError("kanbanError", "");
        if (editError instanceof HTMLElement) {
          editError.textContent = "";
        }
        target.disabled = true;
        try {
          await api("/api/tasks/" + encodeURIComponent(taskId), {
            method: "PATCH",
            body: JSON.stringify({
              phaseId,
              taskId,
              title: titleInput.value,
              description: descriptionInput.value,
              race: raceValue,
              dependencies,
              projectName: activeProjectName,
            }),
          });
          await refreshActiveProject();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setError("kanbanError", message);
          if (editError instanceof HTMLElement) {
            editError.textContent = message;
          }
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
        return;
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
        return;
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
          const runtimeEvent = data.runtimeEvent;
          if (runtimeEvent && runtimeEvent.type === "adapter.output") {
            const span = document.createElement("span");
            const line =
              data.formattedLine ||
              runtimeEvent.payload?.line ||
              data.line ||
              "";
            span.textContent = line + "\\n";
            logModalBody.appendChild(span);
            logModalBody.scrollTop = logModalBody.scrollHeight;
            return;
          }
          if (runtimeEvent && runtimeEvent.type === "terminal.outcome") {
            const status =
              runtimeEvent.payload?.agentStatus ||
              data.status ||
              runtimeEvent.payload?.outcome ||
              "unknown";
            const summary = data.failureSummary ? " Failure: " + data.failureSummary : "";
            logModalStatus.textContent = "Agent status: " + status + "." + summary + " Stream ended.";
            const linksHtml = renderRecoveryLinks(data.recoveryLinks);
            if (linksHtml) {
              const linksLine = document.createElement("div");
              linksLine.innerHTML = "Recovery traces: " + linksHtml;
              logModalStatus.appendChild(document.createElement("br"));
              logModalStatus.appendChild(linksLine);
            }
            source.close();
            currentEventSource = null;
            return;
          }
          if (data.type === "output") {
            const span = document.createElement("span");
            span.textContent = (data.formattedLine || data.line) + "\\n";
            logModalBody.appendChild(span);
            logModalBody.scrollTop = logModalBody.scrollHeight;
          } else if (data.type === "status") {
            const summary = data.failureSummary ? " Failure: " + data.failureSummary : "";
            logModalStatus.textContent = "Agent status: " + data.status + "." + summary + " Stream ended.";
            const linksHtml = renderRecoveryLinks(data.recoveryLinks);
            if (linksHtml) {
              const linksLine = document.createElement("div");
              linksLine.innerHTML = "Recovery traces: " + linksHtml;
              logModalStatus.appendChild(document.createElement("br"));
              logModalStatus.appendChild(linksLine);
            }
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
        const recoveryMaxAttempts = Number.parseInt(
          document.getElementById("globalRecoveryMaxAttempts").value,
          10,
        );
        const globalDefaultRace = Number.parseInt(
          document.getElementById("globalDefaultRace").value,
          10,
        );
        if (
          !Number.isInteger(recoveryMaxAttempts) ||
          recoveryMaxAttempts < 0 ||
          recoveryMaxAttempts > 10
        ) {
          throw new Error(
            "Exception recovery max attempts must be an integer between 0 and 10.",
          );
        }
        if (!Number.isInteger(globalDefaultRace) || globalDefaultRace <= 0) {
          throw new Error("Default race count must be a positive integer.");
        }

        await api("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({
            executionLoop: {
              autoMode: document.getElementById("globalAutoMode").checked,
              defaultRace: globalDefaultRace,
              judgeAdapter: document.getElementById("globalJudgeAdapter").value,
              raceJudgePrompt:
                document.getElementById("globalRaceJudgePrompt").value.trim() || null,
            },
            internalWork: {
              assignee: document.getElementById("globalDefaultAssignee").value
            },
            exceptionRecovery: {
              maxAttempts: recoveryMaxAttempts,
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
        const providerPriority = [];
        document.querySelectorAll("#adaptersSettingsList .card").forEach(card => {
          const enabledInput = card.querySelector(".adapter-enabled");
          const timeoutInput = card.querySelector(".adapter-timeout");
          const id = enabledInput.getAttribute("data-id");
          const timeoutMs = parseInt(timeoutInput.value, 10);
          if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
            throw new Error("Adapter timeout must be a positive integer.");
          }
          agents[id] = {
            enabled: enabledInput.checked,
            timeoutMs
          };
          if (enabledInput.checked) {
            providerPriority.push(id);
          }
        });
        await api("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({
            agents,
            executionLoop: {
              providerPriority,
            },
          })
        });
        status.textContent = "Saved.";
      } catch (err) {
        status.textContent = "";
        error.textContent = err.message;
      }
    });

    document.getElementById("addGateButton").addEventListener("click", () => {
      collectGateFieldValues();
      const type = document.getElementById("addGateType").value;
      const defaults = { type };
      if (type === "command") { defaults.command = ""; }
      if (type === "coverage") { defaults.reportPath = ""; defaults.minPct = 80; }
      if (type === "ai_eval") { defaults.command = ""; defaults.rubric = ""; }
      currentGates.push(defaults);
      renderGatesList(currentGates);
    });

    document.getElementById("saveGatesButton").addEventListener("click", async () => {
      const status = document.getElementById("gatesSettingsStatus");
      const error = document.getElementById("gatesSettingsError");
      status.textContent = "Saving...";
      error.textContent = "";
      try {
        collectGateFieldValues();
        const cleanGates = currentGates.map(g => {
          const clean = { type: g.type };
          for (const [k, v] of Object.entries(g)) {
            if (v !== undefined && v !== "" && k !== "type") {
              clean[k] = v;
            }
          }
          return clean;
        });
        await api("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ executionLoop: { gates: cleanGates } })
        });
        status.textContent = "Saved.";
      } catch (err) {
        status.textContent = "";
        error.textContent = err.message;
      }
    });

    function isProjectUiInteractionActive() {
      const openInlineEditor = kanbanBoard.querySelector(".task-edit-inline:not(.hidden)");
      if (openInlineEditor) {
        return true;
      }

      const activeElement = document.activeElement;
      if (
        !(activeElement instanceof HTMLInputElement) &&
        !(activeElement instanceof HTMLTextAreaElement) &&
        !(activeElement instanceof HTMLSelectElement)
      ) {
        return false;
      }

      return (
        activeElement.closest("#projectContent") !== null ||
        activeElement.closest("#executionSettingsPanel") !== null
      );
    }

    async function init() {
      await refreshProjects();
      await switchProject(activeProjectName);
      await globalRefresh();
      await refreshExecutionStatus();
      
      setInterval(() => {
        globalRefresh().catch(handleRefreshError);
        refreshExecutionStatus().catch(handleRefreshError);
        if (!isProjectUiInteractionActive()) {
          refreshActiveProject().catch(handleRefreshError);
        }
      }, 5000);
    }

    init().catch(handleRefreshError);
  </script>
</body>
</html>`;
}

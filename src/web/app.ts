import type { AgentView, StartAgentInput } from "./agent-supervisor";
import type { ControlCenterService } from "./control-center-service";
import type { UsageService } from "./usage-service";

type AgentControl = {
  list(): AgentView[];
  start(input: StartAgentInput): AgentView;
  kill(id: string): AgentView;
  restart(id: string): AgentView;
};

export type WebAppDependencies = {
  control: ControlCenterService;
  agents: AgentControl;
  usage: UsageService;
  defaultAgentCwd: string;
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
      max-width: 1200px;
      margin: 0 auto;
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
    }
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
  </style>
</head>
<body>
  <main class="layout">
    <section class="card wide">
      <h1>IxADO Control Center <span class="pill">Phase 6</span></h1>
      <div id="stateSummary" class="small"></div>
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
        <select id="taskAssignee">
          <option value="UNASSIGNED">UNASSIGNED</option>
          <option value="MOCK_CLI">MOCK_CLI</option>
          <option value="CODEX_CLI">CODEX_CLI</option>
          <option value="GEMINI_CLI">GEMINI_CLI</option>
          <option value="CLAUDE_CLI">CLAUDE_CLI</option>
        </select>
        <button type="submit">Create Task</button>
      </form>
      <div id="taskError" class="error"></div>
    </section>

    <section class="card">
      <h2>Usage / Quota</h2>
      <div id="usageStatus" class="small">Loading...</div>
      <pre id="usageRaw" class="mono small"></pre>
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
    </section>

    <section class="card wide">
      <h2>Project State</h2>
      <pre id="stateRaw" class="mono"></pre>
    </section>
  </main>
  <script>
    const stateSummary = document.getElementById("stateSummary");
    const stateRaw = document.getElementById("stateRaw");
    const usageStatus = document.getElementById("usageStatus");
    const usageRaw = document.getElementById("usageRaw");
    const taskPhase = document.getElementById("taskPhase");
    const agentTableBody = document.querySelector("#agentTable tbody");
    const defaultAgentCwd = ${JSON.stringify("{{DEFAULT_AGENT_CWD}}")};

    async function api(path, options = {}) {
      const response = await fetch(path, {
        headers: { "content-type": "application/json" },
        ...options,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || response.statusText);
      return data;
    }

    function setError(id, message) {
      document.getElementById(id).textContent = message || "";
    }

    function renderState(state) {
      stateSummary.textContent = "Project " + state.projectName + " | Active phase: " + (state.activePhaseId || "none") + " | Total phases: " + state.phases.length;
      stateRaw.textContent = JSON.stringify(state, null, 2);
      taskPhase.innerHTML = "";
      state.phases.forEach((phase) => {
        const option = document.createElement("option");
        option.value = phase.id;
        option.textContent = phase.name + " (" + phase.status + ")";
        taskPhase.appendChild(option);
      });
    }

    function renderAgents(agents) {
      agentTableBody.innerHTML = "";
      agents.forEach((agent) => {
        const row = document.createElement("tr");
        row.innerHTML = \`
          <td>\${agent.name}<div class="small mono">\${agent.command} \${agent.args.join(" ")}</div></td>
          <td>\${agent.status}</td>
          <td>\${agent.pid ?? "-"}</td>
          <td class="mono">\${agent.taskId ?? "-"}</td>
          <td>
            <div class="row">
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
      renderAgents(agents);
      usageStatus.textContent = usage.available ? "Available" : ("Unavailable: " + (usage.message || "unknown"));
      usageRaw.textContent = usage.snapshot ? JSON.stringify(usage.snapshot.payload, null, 2) : "";
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
        await api("/api/tasks", {
          method: "POST",
          body: JSON.stringify({
            phaseId: document.getElementById("taskPhase").value,
            title: document.getElementById("taskTitle").value,
            description: document.getElementById("taskDescription").value,
            assignee: document.getElementById("taskAssignee").value,
          }),
        });
        await refresh();
      } catch (error) {
        setError("taskError", error.message);
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

    agentTableBody.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) return;
      const action = target.getAttribute("data-action");
      const id = target.getAttribute("data-id");
      if (!action || !id) return;
      setError("agentError", "");
      try {
        await api("/api/agents/" + id + "/" + action, { method: "POST" });
        await refresh();
      } catch (error) {
        setError("agentError", error.message);
      }
    });

    refresh().catch((error) => setError("agentError", error.message));
    setInterval(() => refresh().catch((error) => setError("agentError", error.message)), 5000);
  </script>
</body>
</html>`;
}

export function createWebApp(deps: WebAppDependencies): {
  fetch(request: Request): Promise<Response>;
} {
  const html = controlCenterHtml().replace("{{DEFAULT_AGENT_CWD}}", deps.defaultAgentCwd.replace(/\\/g, "\\\\"));

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

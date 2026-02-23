import type { ApiDependencies } from "./types";
import {
  json,
  readJson,
  asString,
  asInternalAdapterAssignee,
  ensureAllowedAssignee,
} from "./utils";

export async function handleTasksApi(
  request: Request,
  url: URL,
  deps: ApiDependencies,
): Promise<Response | null> {
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

  const updateTaskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
  if (request.method === "PATCH" && updateTaskMatch) {
    const body = await readJson(request);
    const dependenciesRaw = body.dependencies;
    const dependencies = Array.isArray(dependenciesRaw)
      ? dependenciesRaw.filter(
          (value): value is string => typeof value === "string",
        )
      : [];

    const state = await deps.control.updateTask({
      phaseId: asString(body.phaseId) ?? "",
      taskId: decodeURIComponent(updateTaskMatch[1]),
      title: asString(body.title) ?? "",
      description: asString(body.description) ?? "",
      dependencies,
      projectName: asString(body.projectName),
    });
    return json(state, 200);
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

  if (request.method === "POST" && url.pathname === "/api/import/tasks-md") {
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

  return null;
}

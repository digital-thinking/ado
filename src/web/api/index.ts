import { handleAgentsApi } from "./agents";
import { handleExecutionApi } from "./execution";
import { handleProjectsApi } from "./projects";
import { handleSettingsApi } from "./settings";
import { handleTasksApi } from "./tasks";
import type { ApiDependencies } from "./types";
import { json } from "./utils";

export async function handleApi(
  request: Request,
  url: URL,
  deps: ApiDependencies,
): Promise<Response | null> {
  try {
    const agentsResponse = await handleAgentsApi(request, url, deps);
    if (agentsResponse) return agentsResponse;

    const projectsResponse = await handleProjectsApi(request, url, deps);
    if (projectsResponse) return projectsResponse;

    const tasksResponse = await handleTasksApi(request, url, deps);
    if (tasksResponse) return tasksResponse;

    const settingsResponse = await handleSettingsApi(request, url, deps);
    if (settingsResponse) return settingsResponse;

    const executionResponse = await handleExecutionApi(request, url, deps);
    if (executionResponse) return executionResponse;

    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, 400);
  }
}

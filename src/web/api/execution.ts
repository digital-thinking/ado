import type { ApiDependencies } from "./types";
import { asString, json, readJson } from "./utils";

export async function handleExecutionApi(
  request: Request,
  url: URL,
  deps: ApiDependencies,
): Promise<Response | null> {
  if (!deps.execution) {
    return null;
  }

  if (request.method === "GET" && url.pathname === "/api/execution") {
    const projectName = asString(url.searchParams.get("projectName"));
    return json(await deps.execution.getStatus(projectName));
  }

  if (request.method === "POST" && url.pathname === "/api/execution/start") {
    const body = await readJson(request);
    const projectName = asString(body.projectName);
    return json(await deps.execution.startAuto({ projectName }), 202);
  }

  if (request.method === "POST" && url.pathname === "/api/execution/stop") {
    const body = await readJson(request);
    const projectName = asString(body.projectName);
    return json(await deps.execution.stop({ projectName }), 200);
  }

  return null;
}

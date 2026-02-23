import type { ApiDependencies } from "./types";
import { json, readJson, asString, asInternalAdapterAssignee } from "./utils";
import type { CLIAdapterId } from "../../types";

export async function handleProjectsApi(
  request: Request,
  url: URL,
  deps: ApiDependencies,
): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/api/projects") {
    return json(await deps.getProjects());
  }

  const projectStateMatch = /^\/api\/projects\/([^/]+)\/state$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && projectStateMatch) {
    return json(
      await deps.getProjectState(decodeURIComponent(projectStateMatch[1])),
    );
  }

  const projectSettingsMatch = /^\/api\/projects\/([^/]+)\/settings$/.exec(
    url.pathname,
  );
  if (request.method === "PATCH" && projectSettingsMatch) {
    const name = decodeURIComponent(projectSettingsMatch[1]);
    const body = await readJson(request);
    const patch: { autoMode?: boolean; defaultAssignee?: CLIAdapterId } = {};
    if (typeof body.autoMode === "boolean") {
      patch.autoMode = body.autoMode;
    }
    const rawAssignee = asInternalAdapterAssignee(body.defaultAssignee);
    if (rawAssignee !== undefined) {
      patch.defaultAssignee = rawAssignee;
    }
    return json(await deps.updateProjectSettings(name, patch));
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

  if (request.method === "POST" && url.pathname === "/api/phases/active") {
    const body = await readJson(request);
    const state = await deps.control.setActivePhase({
      phaseId: asString(body.phaseId) ?? "",
      projectName: asString(body.projectName),
    });
    return json(state, 200);
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    return json(await deps.control.getState());
  }

  return null;
}

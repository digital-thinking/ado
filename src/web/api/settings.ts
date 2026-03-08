import type { ApiDependencies } from "./types";
import {
  json,
  readJson,
  asString,
  asInternalAdapterAssignee,
  ensureAllowedAssignee,
} from "./utils";
import type { CliSettingsOverride } from "../../types";

export async function handleSettingsApi(
  request: Request,
  url: URL,
  deps: ApiDependencies,
): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/api/settings") {
    return json(await deps.getGlobalSettings());
  }

  if (request.method === "PATCH" && url.pathname === "/api/settings") {
    const body = await readJson(request);
    return json(await deps.updateGlobalSettings(body as CliSettingsOverride));
  }

  if (request.method === "GET" && url.pathname === "/api/usage") {
    return json(await deps.usage.getLatest());
  }

  if (request.method === "GET" && url.pathname === "/api/runtime-config") {
    return json(await deps.getRuntimeConfig());
  }

  if (request.method === "POST" && url.pathname === "/api/runtime-config") {
    const body = await readJson(request);
    const candidateAssignee = asInternalAdapterAssignee(
      body.defaultInternalWorkAssignee,
    );
    if (!candidateAssignee) {
      throw new Error(
        `defaultInternalWorkAssignee must be one of \${deps.availableWorkerAssignees.join(", ")}.`,
      );
    }
    ensureAllowedAssignee(candidateAssignee, deps.availableWorkerAssignees);
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

  if (request.method === "POST" && url.pathname === "/api/internal-work/run") {
    const body = await readJson(request);
    const runtimeConfig = await deps.getRuntimeConfig();
    const assignee =
      asInternalAdapterAssignee(body.assignee) ??
      runtimeConfig.defaultInternalWorkAssignee;
    if (!assignee) {
      throw new Error(
        `assignee must be one of \${deps.availableWorkerAssignees.join(", ")}.`,
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

  return null;
}

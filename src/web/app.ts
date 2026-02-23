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
  RecordRecoveryAttemptInput,
  SetActivePhaseInput,
  StartTaskInput,
  UpdateTaskInput,
} from "./control-center-service";
import type { UsageService } from "./usage-service";
import type {
  CLIAdapterId,
  CliSettings,
  CliSettingsOverride,
  ProjectRecord,
  ProjectState,
} from "../types";
import { handleApi } from "./api";
import { text } from "./api/utils";
import { controlCenterHtml } from "./ui/html";

export type AgentControl = {
  list(): AgentView[];
  start(input: StartAgentInput): AgentView;
  assign(id: string, input: AssignAgentInput): AgentView;
  kill(id: string): AgentView;
  restart(id: string): AgentView;
  subscribe(agentId: string, listener: (event: AgentEvent) => void): () => void;
};

export type ControlCenterControl = {
  getState(projectName?: string): ReturnType<ControlCenterService["getState"]>;
  createPhase(
    input: CreatePhaseInput & { projectName?: string },
  ): ReturnType<ControlCenterService["createPhase"]>;
  createTask(
    input: CreateTaskInput & { projectName?: string },
  ): ReturnType<ControlCenterService["createTask"]>;
  updateTask(
    input: UpdateTaskInput & { projectName?: string },
  ): ReturnType<ControlCenterService["updateTask"]>;
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
  recordRecoveryAttempt(
    input: RecordRecoveryAttemptInput & { projectName?: string },
  ): ReturnType<ControlCenterService["recordRecoveryAttempt"]>;
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

export function createWebApp(deps: WebAppDependencies): {
  fetch(request: Request): Promise<Response>;
} {
  const html = controlCenterHtml({
    webLogFilePath: deps.webLogFilePath,
    cliLogFilePath: deps.cliLogFilePath,
    defaultInternalWorkAssignee: deps.defaultInternalWorkAssignee,
    defaultAutoMode: deps.defaultAutoMode,
    availableWorkerAssigneesJson: JSON.stringify(deps.availableWorkerAssignees),
    projectName: deps.projectName,
  });

  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        return text(html, 200, "text/html; charset=utf-8");
      }

      const apiResponse = await handleApi(request, url, deps);
      if (apiResponse) {
        return apiResponse;
      }

      return text("Not found", 404);
    },
  };
}

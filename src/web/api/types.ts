import type {
  AgentControl,
  ControlCenterControl,
  ExecutionControl,
  RuntimeConfig,
} from "../app";
import type { UsageService } from "../usage-service";
import type {
  CLIAdapterId,
  CliSettings,
  CliSettingsOverride,
  ProjectRecord,
  ProjectState,
} from "../../types";

export interface ApiDependencies {
  control: ControlCenterControl;
  agents: AgentControl;
  usage: UsageService;
  defaultAgentCwd: string;
  projectName: string;
  availableWorkerAssignees: CLIAdapterId[];
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
  execution?: ExecutionControl;
}

import { Bot } from "grammy";

import { CLIAdapterIdSchema, type CLIAdapterId, type ProjectState } from "../types";

export type StateReader = () => Promise<ProjectState>;
export type TaskStarter = (input: {
  taskNumber: number;
  assignee: CLIAdapterId;
}) => Promise<ProjectState>;
export type ActivePhaseSetter = (input: { phaseId: string }) => Promise<ProjectState>;
export type AgentListReader = () => Promise<StatusAgent[]> | StatusAgent[];

export type StatusAgent = {
  id?: string;
  name: string;
  status: "RUNNING" | "STOPPED" | "FAILED" | string;
  phaseId?: string;
  taskId?: string;
};

type TelegramCtx = {
  from?: { id?: number };
  message?: { text?: string };
  reply: (text: string) => Promise<unknown>;
};

export type TelegramRuntime = {
  start: () => Promise<void>;
  stop: () => void;
};

function formatStatus(
  state: ProjectState,
  agents: StatusAgent[],
  availableAssignees: CLIAdapterId[]
): string {
  const activePhase = state.phases.find((phase) => phase.id === state.activePhaseId);
  const activeStatus = activePhase ? `${activePhase.name} (${activePhase.status})` : "none";
  const tasksById = new Map(
    state.phases.flatMap((phase) =>
      phase.tasks.map((task) => [task.id, `${phase.name}: ${task.title}`] as const)
    )
  );
  const runningAgents = agents.filter((agent) => agent.status === "RUNNING");
  const runningLines = runningAgents.length
    ? runningAgents.map((agent, index) => {
        const taskLabel = agent.taskId ? tasksById.get(agent.taskId) ?? agent.taskId : "unassigned";
        return `${index + 1}. ${agent.name} -> ${taskLabel}`;
      })
    : ["none"];

  return [
    `Project: ${state.projectName}`,
    `Root: ${state.rootDir}`,
    `Phases: ${state.phases.length}`,
    `Active: ${activeStatus}`,
    `Available Agents: ${availableAssignees.join(", ")}`,
    `Running Agents (${runningAgents.length}):`,
    ...runningLines,
  ].join("\n");
}

function formatTasks(state: ProjectState): string {
  const activePhase = state.phases.find((phase) => phase.id === state.activePhaseId);

  if (!activePhase) {
    return "No active phase selected.";
  }

  if (activePhase.tasks.length === 0) {
    return `No tasks in active phase: ${activePhase.name}.`;
  }

  const lines = activePhase.tasks.map(
    (task, index) => `${index + 1}. [${task.status}] ${task.title} (${task.assignee})`
  );
  return [`Tasks for ${activePhase.name}:`, ...lines].join("\n");
}

function parseCommandArgs(ctx: TelegramCtx): string[] {
  const raw = ctx.message?.text?.trim() ?? "";
  if (!raw) {
    return [];
  }

  return raw.split(/\s+/).slice(1);
}

async function ensureOwner(ctx: TelegramCtx, ownerId: number): Promise<boolean> {
  if (ctx.from?.id !== ownerId) {
    await ctx.reply("Unauthorized user.");
    return false;
  }

  return true;
}

export async function handleStatusCommand(
  ctx: TelegramCtx,
  ownerId: number,
  readState: StateReader,
  readAgents: AgentListReader,
  availableAssignees: CLIAdapterId[]
): Promise<void> {
  if (!(await ensureOwner(ctx, ownerId))) {
    return;
  }

  const [state, agents] = await Promise.all([readState(), Promise.resolve(readAgents())]);
  await ctx.reply(formatStatus(state, agents, availableAssignees));
}

export async function handleTasksCommand(
  ctx: TelegramCtx,
  ownerId: number,
  readState: StateReader
): Promise<void> {
  if (!(await ensureOwner(ctx, ownerId))) {
    return;
  }

  const state = await readState();
  await ctx.reply(formatTasks(state));
}

export async function handleStartTaskCommand(
  ctx: TelegramCtx,
  ownerId: number,
  availableAssignees: CLIAdapterId[],
  defaultAssignee: CLIAdapterId,
  startTask: TaskStarter
): Promise<void> {
  if (!(await ensureOwner(ctx, ownerId))) {
    return;
  }

  const args = parseCommandArgs(ctx);
  const taskNumberRaw = args[0]?.trim() ?? "";
  const taskNumber = Number(taskNumberRaw);
  const assigneeRaw = args[1]?.trim();
  const parsedAssignee = CLIAdapterIdSchema.safeParse(assigneeRaw ?? defaultAssignee);

  if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
    await ctx.reply("Usage: /starttask <taskNumber> [assignee]");
    return;
  }
  if (!parsedAssignee.success || !availableAssignees.includes(parsedAssignee.data)) {
    await ctx.reply(`Assignee must be one of: ${availableAssignees.join(", ")}.`);
    return;
  }

  await ctx.reply(`Starting task #${taskNumber} with ${parsedAssignee.data}.`);

  try {
    const state = await startTask({
      taskNumber,
      assignee: parsedAssignee.data,
    });
    const phase = state.phases.find((candidate) => candidate.id === state.activePhaseId) ?? state.phases[0];
    const task = phase?.tasks[taskNumber - 1];
    if (!task) {
      throw new Error(`Task #${taskNumber} not found after execution.`);
    }

    await ctx.reply(`Task #${taskNumber} ${task.title} finished with status ${task.status}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Task start failed: ${message}`);
  }
}

export async function handleSetActivePhaseCommand(
  ctx: TelegramCtx,
  ownerId: number,
  setActivePhase: ActivePhaseSetter
): Promise<void> {
  if (!(await ensureOwner(ctx, ownerId))) {
    return;
  }

  const args = parseCommandArgs(ctx);
  const phaseId = args[0]?.trim() ?? "";
  if (!phaseId) {
    await ctx.reply("Usage: /setactivephase <phaseId>");
    return;
  }

  try {
    const state = await setActivePhase({ phaseId });
    const active = state.phases.find((phase) => phase.id === state.activePhaseId);
    await ctx.reply(
      active
        ? `Active phase set to ${active.name}.`
        : `Active phase updated to ${phaseId}.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`Failed to set active phase: ${message}`);
  }
}

type CreateTelegramRuntimeInput = {
  token: string;
  ownerId: number;
  readState: StateReader;
  listAgents: AgentListReader;
  availableAssignees: CLIAdapterId[];
  defaultAssignee: CLIAdapterId;
  startTask: TaskStarter;
  setActivePhase: ActivePhaseSetter;
};

export function createTelegramRuntime(input: CreateTelegramRuntimeInput): TelegramRuntime {
  const bot = new Bot(input.token);

  bot.command("status", async (ctx) => {
    await handleStatusCommand(
      ctx,
      input.ownerId,
      input.readState,
      input.listAgents,
      input.availableAssignees
    );
  });

  bot.command("tasks", async (ctx) => {
    await handleTasksCommand(ctx, input.ownerId, input.readState);
  });

  bot.command("starttask", async (ctx) => {
    await handleStartTaskCommand(
      ctx,
      input.ownerId,
      input.availableAssignees,
      input.defaultAssignee,
      input.startTask
    );
  });
  bot.command("setactivephase", async (ctx) => {
    await handleSetActivePhaseCommand(ctx, input.ownerId, input.setActivePhase);
  });

  bot.catch((error) => {
    const err = error.error;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Telegram bot error: ${message}`);
  });

  return {
    start: async () => {
      try {
        await bot.api.sendMessage(
          input.ownerId,
          "IxADO is online. Send /status, /tasks, /starttask <taskNumber> [assignee], or /setactivephase <phaseId>. Press Ctrl+C in CLI to stop."
        );
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        console.warn(`Unable to send Telegram hello message: ${err}`);
      }

      await bot.start();
    },
    stop: () => {
      bot.stop();
    },
  };
}

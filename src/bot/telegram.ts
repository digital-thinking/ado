import { Bot } from "grammy";

import type { ProjectState } from "../types";

export type StateReader = () => Promise<ProjectState>;

type TelegramCtx = {
  from?: { id?: number };
  reply: (text: string) => Promise<unknown>;
};

export type TelegramRuntime = {
  start: () => Promise<void>;
  stop: () => void;
};

function formatStatus(state: ProjectState): string {
  const activePhase = state.phases.find((phase) => phase.id === state.activePhaseId);
  const activeStatus = activePhase ? `${activePhase.name} (${activePhase.status})` : "none";

  return [
    `Project: ${state.projectName}`,
    `Root: ${state.rootDir}`,
    `Phases: ${state.phases.length}`,
    `Active: ${activeStatus}`,
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

  const lines = activePhase.tasks.map((task) => `- [${task.status}] ${task.title}`);
  return [`Tasks for ${activePhase.name}:`, ...lines].join("\n");
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
  readState: StateReader
): Promise<void> {
  if (!(await ensureOwner(ctx, ownerId))) {
    return;
  }

  const state = await readState();
  await ctx.reply(formatStatus(state));
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

type CreateTelegramRuntimeInput = {
  token: string;
  ownerId: number;
  readState: StateReader;
};

export function createTelegramRuntime(input: CreateTelegramRuntimeInput): TelegramRuntime {
  const bot = new Bot(input.token);

  bot.command("status", async (ctx) => {
    await handleStatusCommand(ctx, input.ownerId, input.readState);
  });

  bot.command("tasks", async (ctx) => {
    await handleTasksCommand(ctx, input.ownerId, input.readState);
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
          "IxADO is online. Send /status or /tasks. Press Ctrl+C in CLI to stop."
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

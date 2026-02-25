import { z } from "zod";

import {
  LifecycleHookNameSchema,
  type LifecycleHookName,
  parseLifecycleHookPayload,
  type LifecycleHookPayloadByName,
} from "../types/lifecycle-hooks";

type HookHandler<T extends LifecycleHookName> = (
  payload: LifecycleHookPayloadByName[T],
) => Promise<void> | void;

export type LifecycleHookHandlers = {
  before_task_start?: HookHandler<"before_task_start">;
  after_task_done?: HookHandler<"after_task_done">;
  on_recovery?: HookHandler<"on_recovery">;
  on_ci_failed?: HookHandler<"on_ci_failed">;
};

export type LifecycleHookRegistration = {
  id: string;
  description?: string;
  handlers: LifecycleHookHandlers;
};

export type LifecycleHookRunOptions = {
  timeoutMs?: number;
};

const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

const LifecycleHookRegistrationSchema = z
  .object({
    id: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    handlers: z
      .object({
        before_task_start: z.unknown().optional(),
        after_task_done: z.unknown().optional(),
        on_recovery: z.unknown().optional(),
        on_ci_failed: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();

const LifecycleHookRunOptionsSchema = z
  .object({
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export class LifecycleHookExecutionError extends Error {
  readonly hookName: LifecycleHookName;
  readonly registrationId: string;
  readonly timeoutMs: number;
  readonly durationMs: number;
  readonly causeError: Error;

  constructor(input: {
    hookName: LifecycleHookName;
    registrationId: string;
    timeoutMs: number;
    durationMs: number;
    cause: unknown;
  }) {
    const causeError =
      input.cause instanceof Error
        ? input.cause
        : new Error(String(input.cause ?? "Unknown hook error"));

    super(
      `Lifecycle hook \"${input.hookName}\" failed for registration \"${input.registrationId}\" after ${input.durationMs}ms (timeout ${input.timeoutMs}ms): ${causeError.message}`,
    );
    this.name = "LifecycleHookExecutionError";
    this.hookName = input.hookName;
    this.registrationId = input.registrationId;
    this.timeoutMs = input.timeoutMs;
    this.durationMs = input.durationMs;
    this.causeError = causeError;
  }

  toLogObject(): {
    name: string;
    hookName: LifecycleHookName;
    registrationId: string;
    timeoutMs: number;
    durationMs: number;
    message: string;
    cause: {
      name: string;
      message: string;
      stack?: string;
    };
  } {
    return {
      name: this.name,
      hookName: this.hookName,
      registrationId: this.registrationId,
      timeoutMs: this.timeoutMs,
      durationMs: this.durationMs,
      message: this.message,
      cause: {
        name: this.causeError.name,
        message: this.causeError.message,
        stack: this.causeError.stack,
      },
    };
  }
}

class LifecycleHookTimeoutError extends Error {
  constructor(input: {
    hookName: LifecycleHookName;
    registrationId: string;
    timeoutMs: number;
  }) {
    super(
      `Lifecycle hook \"${input.hookName}\" timed out for registration \"${input.registrationId}\" after ${input.timeoutMs}ms.`,
    );
    this.name = "LifecycleHookTimeoutError";
  }
}

export function validateLifecycleHookRegistration(
  registration: LifecycleHookRegistration,
): LifecycleHookRegistration {
  const parsed = LifecycleHookRegistrationSchema.parse(registration);
  const hooks = Object.entries(parsed.handlers).filter(
    ([, handler]) => handler !== undefined,
  );
  if (hooks.length === 0) {
    throw new Error(
      `Lifecycle hook registration "${parsed.id}" must register at least one handler.`,
    );
  }

  for (const [hookName, handler] of hooks) {
    if (typeof handler !== "function") {
      throw new Error(
        `Lifecycle hook "${hookName}" for registration "${parsed.id}" must be a function.`,
      );
    }
  }

  return {
    id: parsed.id,
    description: parsed.description,
    handlers: registration.handlers,
  };
}

type RegisteredHook<T extends LifecycleHookName> = {
  registrationId: string;
  handler: HookHandler<T>;
};

type HookStore = {
  [K in LifecycleHookName]: RegisteredHook<K>[];
};

function createEmptyHookStore(): HookStore {
  return {
    before_task_start: [],
    after_task_done: [],
    on_recovery: [],
    on_ci_failed: [],
  };
}

async function runWithTimeout<T>(
  action: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(onTimeout());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

export class LifecycleHookRegistry {
  private readonly store: HookStore = createEmptyHookStore();
  private readonly registrationIds = new Set<string>();

  constructor(registrations?: readonly LifecycleHookRegistration[]) {
    if (registrations) {
      this.registerMany(registrations);
    }
  }

  register(registration: LifecycleHookRegistration): void {
    const validated = validateLifecycleHookRegistration(registration);

    if (this.registrationIds.has(validated.id)) {
      throw new Error(
        `Lifecycle hook registration "${validated.id}" already exists.`,
      );
    }
    this.registrationIds.add(validated.id);

    const handlerEntries = Object.entries(validated.handlers).filter(
      ([, handler]) => handler !== undefined,
    ) as Array<[LifecycleHookName, HookHandler<LifecycleHookName>]>;

    for (const [hookName, handler] of handlerEntries) {
      this.store[hookName].push({
        registrationId: validated.id,
        handler: handler as HookHandler<any>,
      });
    }
  }

  registerMany(registrations: readonly LifecycleHookRegistration[]): void {
    for (const registration of registrations) {
      this.register(registration);
    }
  }

  getHandlers<T extends LifecycleHookName>(
    hookName: T,
  ): ReadonlyArray<RegisteredHook<T>> {
    LifecycleHookNameSchema.parse(hookName);
    return this.store[hookName];
  }

  async run<T extends LifecycleHookName>(
    hookName: T,
    payload: unknown,
    options?: LifecycleHookRunOptions,
  ): Promise<void> {
    const validatedPayload = parseLifecycleHookPayload(hookName, payload);
    const handlers = this.getHandlers(hookName);
    const validatedOptions = LifecycleHookRunOptionsSchema.parse(options ?? {});
    const timeoutMs = validatedOptions.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;

    for (const registered of handlers) {
      const startedAt = Date.now();
      try {
        await runWithTimeout(
          Promise.resolve(registered.handler(validatedPayload)),
          timeoutMs,
          () =>
            new LifecycleHookTimeoutError({
              hookName,
              registrationId: registered.registrationId,
              timeoutMs,
            }),
        );
      } catch (error) {
        throw new LifecycleHookExecutionError({
          hookName,
          registrationId: registered.registrationId,
          timeoutMs,
          durationMs: Math.max(1, Date.now() - startedAt),
          cause: error,
        });
      }
    }
  }
}

export function createLifecycleHookRegistry(
  registrations?: readonly LifecycleHookRegistration[],
): LifecycleHookRegistry {
  return new LifecycleHookRegistry(registrations);
}

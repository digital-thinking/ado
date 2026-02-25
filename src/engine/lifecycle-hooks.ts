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
  ): Promise<void> {
    const validatedPayload = parseLifecycleHookPayload(hookName, payload);
    const handlers = this.getHandlers(hookName);
    for (const registered of handlers) {
      await registered.handler(validatedPayload);
    }
  }
}

export function createLifecycleHookRegistry(
  registrations?: readonly LifecycleHookRegistration[],
): LifecycleHookRegistry {
  return new LifecycleHookRegistry(registrations);
}

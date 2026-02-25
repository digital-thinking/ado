import { z } from "zod";

import {
  CLIAdapterIdSchema,
  ExceptionMetadataSchema,
  ExceptionRecoveryResultSchema,
  TaskStatusSchema,
} from "./index";

export const LifecycleHookNameSchema = z.enum([
  "before_task_start",
  "after_task_done",
  "on_recovery",
  "on_ci_failed",
]);
export type LifecycleHookName = z.infer<typeof LifecycleHookNameSchema>;

const LifecycleTaskContextSchema = z
  .object({
    projectName: z.string().min(1),
    phaseId: z.string().uuid(),
    phaseName: z.string().min(1),
    taskId: z.string().uuid(),
    taskTitle: z.string().min(1),
    taskNumber: z.number().int().positive(),
  })
  .strict();

export const BeforeTaskStartHookPayloadSchema =
  LifecycleTaskContextSchema.extend({
    assignee: CLIAdapterIdSchema,
    resume: z.boolean(),
  }).strict();
export type BeforeTaskStartHookPayload = z.infer<
  typeof BeforeTaskStartHookPayloadSchema
>;

export const AfterTaskDoneHookPayloadSchema = LifecycleTaskContextSchema.extend(
  {
    assignee: CLIAdapterIdSchema,
    status: TaskStatusSchema,
  },
).strict();
export type AfterTaskDoneHookPayload = z.infer<
  typeof AfterTaskDoneHookPayloadSchema
>;

export const OnRecoveryHookPayloadSchema = z
  .object({
    projectName: z.string().min(1),
    phaseId: z.string().uuid(),
    phaseName: z.string().min(1),
    taskId: z.string().uuid().optional(),
    taskTitle: z.string().min(1).optional(),
    attemptNumber: z.number().int().positive(),
    exception: ExceptionMetadataSchema,
    result: ExceptionRecoveryResultSchema,
  })
  .strict();
export type OnRecoveryHookPayload = z.infer<typeof OnRecoveryHookPayloadSchema>;

export const OnCiFailedHookPayloadSchema = z
  .object({
    projectName: z.string().min(1),
    phaseId: z.string().uuid(),
    phaseName: z.string().min(1),
    prNumber: z.number().int().positive(),
    prUrl: z.string().url(),
    ciStatusContext: z.string().min(1),
    createdFixTaskCount: z.number().int().min(0),
  })
  .strict();
export type OnCiFailedHookPayload = z.infer<typeof OnCiFailedHookPayloadSchema>;

export const LifecycleHookPayloadSchemas = {
  before_task_start: BeforeTaskStartHookPayloadSchema,
  after_task_done: AfterTaskDoneHookPayloadSchema,
  on_recovery: OnRecoveryHookPayloadSchema,
  on_ci_failed: OnCiFailedHookPayloadSchema,
} as const;

export type LifecycleHookPayloadByName = {
  before_task_start: BeforeTaskStartHookPayload;
  after_task_done: AfterTaskDoneHookPayload;
  on_recovery: OnRecoveryHookPayload;
  on_ci_failed: OnCiFailedHookPayload;
};

export function parseLifecycleHookPayload<T extends LifecycleHookName>(
  hook: T,
  payload: unknown,
): LifecycleHookPayloadByName[T] {
  switch (hook) {
    case "before_task_start":
      return BeforeTaskStartHookPayloadSchema.parse(
        payload,
      ) as LifecycleHookPayloadByName[T];
    case "after_task_done":
      return AfterTaskDoneHookPayloadSchema.parse(
        payload,
      ) as LifecycleHookPayloadByName[T];
    case "on_recovery":
      return OnRecoveryHookPayloadSchema.parse(
        payload,
      ) as LifecycleHookPayloadByName[T];
    case "on_ci_failed":
      return OnCiFailedHookPayloadSchema.parse(
        payload,
      ) as LifecycleHookPayloadByName[T];
  }
}

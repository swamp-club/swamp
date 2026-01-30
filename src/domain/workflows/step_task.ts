import { z } from "zod";

/**
 * Zod schema for step tasks.
 *
 * A task can be either:
 * - A model method invocation
 * - A shell command execution
 */
export const StepTaskSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("model_method"),
    modelIdOrName: z.string().min(1),
    methodName: z.string().min(1),
  }),
  z.object({
    type: z.literal("shell"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    workingDir: z.string().optional(),
    timeout: z.number().positive().optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
]);

/**
 * Type representing step task data.
 */
export type StepTaskData = z.infer<typeof StepTaskSchema>;

/**
 * StepTask is a value object representing the work to be performed by a step.
 *
 * Immutable with equality based on value.
 */
export class StepTask {
  private constructor(readonly data: StepTaskData) {}

  /**
   * Creates a StepTask from raw data.
   */
  static fromData(data: StepTaskData): StepTask {
    const validated = StepTaskSchema.parse(data);
    return new StepTask(validated);
  }

  /**
   * Creates a model method task.
   */
  static modelMethod(modelIdOrName: string, methodName: string): StepTask {
    return new StepTask({
      type: "model_method",
      modelIdOrName,
      methodName,
    });
  }

  /**
   * Creates a shell command task.
   */
  static shell(
    command: string,
    options?: {
      args?: string[];
      workingDir?: string;
      timeout?: number;
      env?: Record<string, string>;
    },
  ): StepTask {
    return new StepTask({
      type: "shell",
      command,
      args: options?.args ?? [],
      workingDir: options?.workingDir,
      timeout: options?.timeout,
      env: options?.env,
    });
  }

  /**
   * Returns true if this is a model method task.
   */
  isModelMethod(): boolean {
    return this.data.type === "model_method";
  }

  /**
   * Returns true if this is a shell command task.
   */
  isShell(): boolean {
    return this.data.type === "shell";
  }

  /**
   * Converts to plain data for persistence.
   */
  toData(): StepTaskData {
    return structuredClone(this.data);
  }

  /**
   * Value equality comparison.
   */
  equals(other: StepTask): boolean {
    return JSON.stringify(this.data) === JSON.stringify(other.data);
  }
}

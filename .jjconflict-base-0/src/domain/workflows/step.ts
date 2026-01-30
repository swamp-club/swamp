import { z } from "zod";
import {
  TriggerCondition,
  type TriggerConditionData,
  TriggerConditionSchema,
} from "./trigger_condition.ts";
import { StepTask, StepTaskSchema } from "./step_task.ts";

/**
 * Schema for step dependency with condition.
 */
export const StepDependencySchema = z.object({
  step: z.string().min(1),
  condition: TriggerConditionSchema,
});

/**
 * Type representing step dependency data.
 */
export type StepDependencyData = z.infer<typeof StepDependencySchema>;

/**
 * Zod schema for Step entity.
 */
export const StepSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  task: StepTaskSchema,
  dependsOn: z.array(StepDependencySchema).default([]),
  weight: z.number().default(0),
});

/**
 * Type representing step data.
 */
export type StepData = z.infer<typeof StepSchema>;

/**
 * Step dependency with resolved TriggerCondition.
 */
export interface StepDependency {
  step: string;
  condition: TriggerCondition;
}

/**
 * Properties for creating a new Step.
 */
export interface CreateStepProps {
  name: string;
  description?: string;
  task: StepTask;
  dependsOn?: StepDependency[];
  weight?: number;
}

/**
 * Step is an entity within a Job that represents a single unit of work.
 *
 * Each step has:
 * - A unique name (within the job)
 * - An optional description
 * - A task to execute (model method or shell command)
 * - Dependencies on other steps with trigger conditions
 * - A weight for deterministic topological sorting
 */
export class Step {
  private constructor(
    readonly name: string,
    readonly description: string | undefined,
    private _task: StepTask,
    private _dependsOn: StepDependency[],
    readonly weight: number,
  ) {}

  /**
   * Creates a new Step.
   */
  static create(props: CreateStepProps): Step {
    const data = StepSchema.parse({
      name: props.name,
      description: props.description,
      task: props.task.toData(),
      dependsOn: (props.dependsOn ?? []).map((d) => ({
        step: d.step,
        condition: d.condition.toData(),
      })),
      weight: props.weight ?? 0,
    });

    return Step.fromData(data);
  }

  /**
   * Reconstructs a Step from persisted data.
   */
  static fromData(data: StepData): Step {
    const validated = StepSchema.parse(data);
    const task = StepTask.fromData(validated.task);
    const dependsOn = validated.dependsOn.map((d) => ({
      step: d.step,
      condition: TriggerCondition.fromData(d.condition),
    }));

    return new Step(
      validated.name,
      validated.description,
      task,
      dependsOn,
      validated.weight,
    );
  }

  /**
   * Returns the task for this step.
   */
  get task(): StepTask {
    return this._task;
  }

  /**
   * Returns the dependencies for this step.
   */
  get dependsOn(): ReadonlyArray<StepDependency> {
    return this._dependsOn;
  }

  /**
   * Returns the names of all steps this step depends on.
   */
  getDependencyNames(): string[] {
    return this._dependsOn.map((d) => d.step);
  }

  /**
   * Converts to plain data for persistence.
   */
  toData(): StepData {
    return {
      name: this.name,
      description: this.description,
      task: this._task.toData(),
      dependsOn: this._dependsOn.map((d) => ({
        step: d.step,
        condition: d.condition.toData() as TriggerConditionData,
      })),
      weight: this.weight,
    };
  }
}

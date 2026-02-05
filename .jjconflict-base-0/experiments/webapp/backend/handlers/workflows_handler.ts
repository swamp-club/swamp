/**
 * HTTP handlers for workflows API endpoints.
 */

import type { RouteContext } from "../router.ts";
import { errorResponse, jsonResponse } from "../router.ts";
import type { WorkflowRepository } from "../../../../src/domain/workflows/repositories.ts";
import { createWorkflowId } from "../../../../src/domain/workflows/workflow_id.ts";
import { Workflow } from "../../../../src/domain/workflows/workflow.ts";
import { Job } from "../../../../src/domain/workflows/job.ts";
import { Step } from "../../../../src/domain/workflows/step.ts";
import { StepTask } from "../../../../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../../../../src/domain/workflows/trigger_condition.ts";

export function createWorkflowsHandlers(
  workflowRepository: WorkflowRepository,
) {
  function workflowToResponse(workflow: Workflow) {
    return {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      version: workflow.version,
      jobs: workflow.jobs.map((job) => ({
        name: job.name,
        description: job.description,
        dependsOn: job.dependsOn.map((d) => ({
          job: d.job,
          condition: d.condition.toData(),
        })),
        weight: job.weight,
        steps: job.steps.map((step) => ({
          name: step.name,
          description: step.description,
          task: step.task.toData(),
          dependsOn: step.dependsOn.map((d) => ({
            step: d.step,
            condition: d.condition.toData(),
          })),
          weight: step.weight,
        })),
      })),
    };
  }

  async function listWorkflows(_ctx: RouteContext): Promise<Response> {
    const workflows = await workflowRepository.findAll();

    const result = workflows.map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      version: workflow.version,
      jobCount: workflow.jobs.length,
    }));

    return jsonResponse({ workflows: result });
  }

  async function getWorkflow(ctx: RouteContext): Promise<Response> {
    const idParam = ctx.params.id;

    try {
      const id = createWorkflowId(idParam);
      const workflow = await workflowRepository.findById(id);

      if (!workflow) {
        return errorResponse("Workflow not found", 404);
      }

      return jsonResponse(workflowToResponse(workflow));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(message, 400);
    }
  }

  function parseStepData(stepData: Record<string, unknown>): Step {
    const taskData = stepData.task as Record<string, unknown>;
    const task = StepTask.fromData(
      taskData as Parameters<typeof StepTask.fromData>[0],
    );

    const dependsOn =
      (stepData.dependsOn as Array<{ step: string; condition: unknown }>) ?? [];

    return Step.create({
      name: stepData.name as string,
      description: stepData.description as string | undefined,
      task,
      dependsOn: dependsOn.map((d) => ({
        step: d.step,
        condition: TriggerCondition.fromData(
          d.condition as Parameters<typeof TriggerCondition.fromData>[0],
        ),
      })),
      weight: stepData.weight as number | undefined,
    });
  }

  function parseJobData(jobData: Record<string, unknown>): Job {
    const stepsData = (jobData.steps as Array<Record<string, unknown>>) ?? [];
    const steps = stepsData.map(parseStepData);

    const dependsOn =
      (jobData.dependsOn as Array<{ job: string; condition: unknown }>) ?? [];

    return Job.create({
      name: jobData.name as string,
      description: jobData.description as string | undefined,
      steps,
      dependsOn: dependsOn.map((d) => ({
        job: d.job,
        condition: TriggerCondition.fromData(
          d.condition as Parameters<typeof TriggerCondition.fromData>[0],
        ),
      })),
      weight: jobData.weight as number | undefined,
    });
  }

  async function createWorkflow(ctx: RouteContext): Promise<Response> {
    try {
      const body = await ctx.request.json();

      if (body.name) {
        const existing = await workflowRepository.findByName(body.name);
        if (existing) {
          return errorResponse(
            `Workflow with name '${body.name}' already exists`,
            409,
          );
        }
      }

      const jobsData = (body.jobs as Array<Record<string, unknown>>) ?? [];
      const jobs = jobsData.map(parseJobData);

      const workflow = Workflow.create({
        name: body.name,
        description: body.description,
        version: body.version,
        jobs,
      });

      await workflowRepository.save(workflow);

      return jsonResponse(workflowToResponse(workflow), 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(message, 400);
    }
  }

  async function updateWorkflow(ctx: RouteContext): Promise<Response> {
    const idParam = ctx.params.id;

    try {
      const id = createWorkflowId(idParam);

      const existing = await workflowRepository.findById(id);
      if (!existing) {
        return errorResponse("Workflow not found", 404);
      }

      const body = await ctx.request.json();

      if (body.name && body.name !== existing.name) {
        const existingWithName = await workflowRepository.findByName(body.name);
        if (existingWithName) {
          return errorResponse(
            `Workflow with name '${body.name}' already exists`,
            409,
          );
        }
      }

      let jobs: Job[];
      if (body.jobs && Array.isArray(body.jobs)) {
        jobs = body.jobs.map((jobData: Record<string, unknown>) =>
          parseJobData(jobData)
        );
      } else {
        jobs = [...existing.jobs];
      }

      const updated = Workflow.create({
        id: existing.id,
        name: body.name ?? existing.name,
        description: body.description ?? existing.description,
        version: body.version ?? existing.version,
        jobs,
      });

      await workflowRepository.save(updated);

      return jsonResponse(workflowToResponse(updated));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(message, 400);
    }
  }

  async function deleteWorkflow(ctx: RouteContext): Promise<Response> {
    const idParam = ctx.params.id;

    try {
      const id = createWorkflowId(idParam);

      const existing = await workflowRepository.findById(id);
      if (!existing) {
        return errorResponse("Workflow not found", 404);
      }

      await workflowRepository.delete(id);

      return new Response(null, { status: 204 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(message, 400);
    }
  }

  return {
    listWorkflows,
    getWorkflow,
    createWorkflow,
    updateWorkflow,
    deleteWorkflow,
  };
}

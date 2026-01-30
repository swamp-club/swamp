/**
 * HTTP handlers for workflow runs API endpoints.
 */

import type { RouteContext } from "../router.ts";
import { errorResponse, jsonResponse } from "../router.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../../../src/domain/workflows/repositories.ts";
import type { OutputRepository } from "../../../../src/domain/models/repositories.ts";
import { createWorkflowId } from "../../../../src/domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../../../../src/domain/workflows/workflow_run.ts";
import {
  isPartialId,
  matchByPartialId,
} from "../../../../src/domain/models/model_lookup.ts";

export function createWorkflowRunsHandlers(
  workflowRunRepository: WorkflowRunRepository,
  workflowRepository: WorkflowRepository,
  outputRepository: OutputRepository,
) {
  function runToSummary(run: WorkflowRun) {
    return {
      id: run.id,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      status: run.status,
      startedAt: run.startedAt?.toISOString(),
      completedAt: run.completedAt?.toISOString(),
      jobCount: run.jobs.length,
    };
  }

  function runToDetail(
    run: WorkflowRun,
    outputsByStep: Map<string, string>,
  ) {
    return {
      id: run.id,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      status: run.status,
      startedAt: run.startedAt?.toISOString(),
      completedAt: run.completedAt?.toISOString(),
      jobs: run.jobs.map((job) => ({
        jobName: job.jobName,
        status: job.status,
        startedAt: job.startedAt?.toISOString(),
        completedAt: job.completedAt?.toISOString(),
        steps: job.steps.map((step) => ({
          stepName: step.stepName,
          status: step.status,
          startedAt: step.startedAt?.toISOString(),
          completedAt: step.completedAt?.toISOString(),
          error: step.error,
          output: step.output,
          outputId: outputsByStep.get(step.stepName),
        })),
      })),
    };
  }

  async function listWorkflowRuns(_ctx: RouteContext): Promise<Response> {
    const allRuns = await workflowRunRepository.findAllGlobal();

    // Get outputs for each run to provide output counts
    const runsWithOutputCounts = await Promise.all(
      allRuns.map(async ({ run }) => {
        // Find outputs that belong to this workflow run
        const allOutputs = await outputRepository.findAllGlobal();
        const runOutputs = allOutputs.filter(
          (o) => o.output.provenance.workflowRunId === run.id,
        );

        return {
          ...runToSummary(run),
          outputCount: runOutputs.length,
        };
      }),
    );

    return jsonResponse({ workflowRuns: runsWithOutputCounts });
  }

  async function getWorkflowRun(ctx: RouteContext): Promise<Response> {
    const idParam = ctx.params.id;

    if (!isPartialId(idParam)) {
      return errorResponse(
        `Invalid workflow run ID format: ${idParam}. Expected a UUID or partial ID (3+ hex characters).`,
        400,
      );
    }

    const allRuns = await workflowRunRepository.findAllGlobal();
    const matchResult = matchByPartialId(
      allRuns.map((r) => ({ id: r.run.id, item: r })),
      idParam,
    );

    if (matchResult.status === "not_found") {
      return errorResponse(`Workflow run not found: ${idParam}`, 404);
    }

    if (matchResult.status === "ambiguous") {
      return errorResponse(
        `Ambiguous ID prefix "${idParam}" matches multiple workflow runs: ${
          matchResult.matches.map((m) => m.id).join(", ")
        }`,
        400,
      );
    }

    const { run } = matchResult.match;

    // Get all outputs for this workflow run
    const allOutputs = await outputRepository.findAllGlobal();
    const runOutputs = allOutputs.filter(
      (o) => o.output.provenance.workflowRunId === run.id,
    );

    // Map outputs with their model type info
    const outputs = runOutputs.map(({ output, type }) => ({
      id: output.id,
      modelInputId: output.modelInputId,
      type: type.normalized,
      methodName: output.methodName,
      status: output.status,
      startedAt: output.startedAt.toISOString(),
      completedAt: output.completedAt?.toISOString(),
      durationMs: output.durationMs,
      stepName: output.provenance.stepName,
    }));

    // Sort by startedAt ascending (execution order)
    outputs.sort((a, b) =>
      new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
    );

    // Build a map of stepName -> outputId for linking steps to outputs
    const outputsByStep = new Map<string, string>();
    for (const output of outputs) {
      if (output.stepName) {
        outputsByStep.set(output.stepName, output.id);
      }
    }

    return jsonResponse({
      ...runToDetail(run, outputsByStep),
      outputs,
    });
  }

  async function listWorkflowRunsByWorkflow(
    ctx: RouteContext,
  ): Promise<Response> {
    const workflowIdParam = ctx.params.workflowId;

    try {
      const workflowId = createWorkflowId(workflowIdParam);

      // Verify workflow exists
      const workflow = await workflowRepository.findById(workflowId);
      if (!workflow) {
        return errorResponse("Workflow not found", 404);
      }

      const runs = await workflowRunRepository.findAllByWorkflowId(workflowId);

      const result = runs.map((run) => runToSummary(run));

      return jsonResponse({ workflowRuns: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(message, 400);
    }
  }

  return {
    listWorkflowRuns,
    getWorkflowRun,
    listWorkflowRunsByWorkflow,
  };
}

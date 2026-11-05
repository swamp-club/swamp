// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { getLogger } from "@logtape/logtape";
import { cancelled, type SwampError } from "../errors.ts";
import type { LibSwampContext } from "../context.ts";
import { withUnitOfWork } from "../unit_of_work.ts";
import type {
  WorkflowExecutionEvent,
  WorkflowExecutionService,
} from "../../domain/workflows/execution_service.ts";
import { markErrorPaths } from "../../domain/errors.ts";
import type { MethodExecutionEvent } from "../../domain/models/method_events.ts";
import type { EnvVarUsageDetail } from "../../domain/models/validation_service.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import { findWorkflowById } from "../../domain/workflows/workflow_lookup.ts";
import type {
  ApprovalDecisionData,
  WorkflowRun,
} from "../../domain/workflows/workflow_run.ts";
import type { StepRun } from "../../domain/workflows/workflow_run.ts";
import {
  createDataRepositoryAttributeReader,
  type ResolvedStepOutputs,
  type ResourceAttributeReader,
  type ResourceReadPolicy,
  StepOutputResolver,
} from "../../domain/workflows/step_output_resolver.ts";
import type { WebhookPayload } from "../../domain/expressions/model_resolver.ts";
import type {
  ApprovalView,
  StepArtifactsData,
  StepRunView,
  WorkflowRunView,
} from "./workflow_run_view.ts";
import type { AssertSeverity } from "../../domain/workflows/step_task.ts";
import type { ReportResultView } from "../models/model_method_run_view.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import {
  coerceInputTypes,
  type InputValidationError,
  InputValidationService,
} from "../../domain/inputs/mod.ts";
import type { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import type { UnifiedDataRepository } from "../../domain/data/repositories.ts";
import { createEphemeralStore } from "../../infrastructure/persistence/ephemeral_store.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
import {
  withGeneratorSpan,
  withGeneratorTraceContext,
} from "../../infrastructure/tracing/mod.ts";
import { WorkflowTelemetryBridge } from "./telemetry_bridge.ts";
import {
  findBrokenWorkflow,
  findMisnamedWorkflow,
  type MisnamedWorkflow,
  workflowsDirFor,
} from "./broken_workflow.ts";
import {
  type SkippedSupersedeData,
  type SupersedeDeps,
  supersedeMatchInputs,
  supersedeSuspendedRuns,
} from "./supersede.ts";
import type { EvaluatedWorkflowCache } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import type { DetachedNestedRunData } from "./nested_runs.ts";
import {
  type CascadedNestedRunData,
  nestedCascadeFields,
} from "./nested_cascade.ts";

export interface WorkflowRunJobInfo {
  id: string;
  stepCount: number;
  dependsOn: string[];
}

export type WorkflowRunEvent =
  | { kind: "validating_inputs" }
  | {
    kind: "superseded_runs";
    cancelledRunIds: string[];
    detachedNestedRuns?: DetachedNestedRunData[];
    cancelledNestedRuns?: CascadedNestedRunData[];
    stopRequestedNestedRuns?: CascadedNestedRunData[];
    skippedRuns?: SkippedSupersedeData[];
  }
  | { kind: "evaluating_workflow" }
  | {
    kind: "started";
    runId: string;
    /**
     * Set on the started event of a nested workflow's run: the id of the run
     * whose step called it. Consumers that track a run by id act only on a
     * started event without it.
     */
    parentRunId?: string;
    workflowName: string;
    jobs: WorkflowRunJobInfo[];
  }
  | { kind: "job_started"; jobId: string }
  | { kind: "job_completed"; jobId: string; status: string }
  | { kind: "job_skipped"; jobId: string }
  | {
    kind: "step_started";
    jobId: string;
    stepId: string;
    forEachTemplate?: string;
    forEachIndex?: number;
  }
  | {
    kind: "step_completed";
    jobId: string;
    stepId: string;
    executor?: string;
    forEachTemplate?: string;
    forEachIndex?: number;
  }
  | {
    kind: "step_skipped";
    jobId: string;
    stepId: string;
    reason?: "guarded" | "dependency";
    guardExpression?: string;
    guardResult?: unknown;
    forEachTemplate?: string;
    forEachIndex?: number;
  }
  | {
    kind: "approval_requested";
    runId: string;
    workflowName?: string;
    jobId: string;
    stepId: string;
    prompt: string;
    timeout?: number;
  }
  | {
    kind: "signal_wait_requested";
    runId: string;
    workflowName?: string;
    jobId: string;
    stepId: string;
    waitId: string;
    deadline: string;
    key?: string;
  }
  | {
    kind: "step_failed";
    jobId: string;
    stepId: string;
    error: string;
    errorCode?: string;
    allowedFailure?: boolean;
    nestedRun?: { workflowId: string; workflowName: string };
    modelName?: string;
    methodName?: string;
    /**
     * on a wait_key_held failure: the open wait that holds the key, as its own
     * registration names it; the error stays bare
     */
    waitKeyHolder?: WaitKeyHolder;
    forEachTemplate?: string;
    forEachIndex?: number;
  }
  | {
    kind: "model_resolved";
    jobId: string;
    stepId: string;
    modelName: string;
    modelType: string;
    modelId: string;
    methodName: string;
  }
  | {
    kind: "env_var_warning";
    jobId: string;
    stepId: string;
    modelName: string;
    envVars: EnvVarUsageDetail[];
    message: string;
  }
  | {
    kind: "method_executing";
    jobId: string;
    stepId: string;
    modelName: string;
    methodName: string;
  }
  | {
    kind: "method_output";
    jobId: string;
    stepId: string;
    modelName: string;
    methodName: string;
    stream: "stdout" | "stderr";
    line: string;
  }
  | {
    kind: "step_queued";
    jobId: string;
    stepId: string;
    requirement: string;
  }
  | {
    kind: "step_target_disconnected";
    jobId: string;
    stepId: string;
    target: string;
  }
  | {
    kind: "method_event";
    jobId: string;
    stepId: string;
    modelName: string;
    methodName: string;
    event: MethodExecutionEvent;
  }
  | {
    kind: "assert_result";
    jobId: string;
    stepId: string;
    passed: boolean;
    message: string;
    severity: AssertSeverity;
    expr: string;
    error?: string;
  }
  | {
    kind: "report_started";
    reportName: string;
    scope: string;
    jobId?: string;
    stepId?: string;
  }
  | {
    kind: "report_completed";
    reportName: string;
    scope: string;
    markdown: string;
    json: Record<string, unknown>;
    jobId?: string;
    stepId?: string;
  }
  | {
    kind: "report_failed";
    reportName: string;
    scope: string;
    error: string;
    jobId?: string;
    stepId?: string;
  }
  | { kind: "completed"; run: WorkflowRunView }
  | { kind: "cancelled"; run: WorkflowRunView; reason?: string }
  | {
    kind: "suspended";
    run: WorkflowRunView;
    jobId: string;
    stepId: string;
    prompt: string;
    timeout?: number;
    /**
     * set when the run suspended on a nested workflow step waiting on a
     * suspended child run; jobId and stepId are then the nested step
     */
    nested?: { workflowName: string; runId: string };
    /**
     * set when the run suspended on a step waiting for a signal; jobId and
     * stepId are then that step
     */
    wait?: { id: string; deadline: string; key?: string };
    /**
     * open signal waits held by nested runs, each at the innermost run that has
     * to act; a run on a server learns of them only here, as
     * signal_wait_requested is not sent to a client
     */
    nestedSignalWaits?: NestedSignalWaitData[];
  }
  | { kind: "error"; error: SwampError };

export interface NestedSignalWaitData {
  workflowId: string;
  workflowName: string;
  runId: string;
  jobId: string;
  stepId: string;
  waitId: string;
  deadline: string;
  key?: string;
}

export interface WaitKeyHolder {
  workflowId: string;
  workflowName: string;
  key: string;
  runId: string;
  stepName: string;
  waitId: string;
}

/**
 * lives in libswamp so it stays free of domain.telemetry imports beyond DTO
 * shapes; non-CLI consumers pass undefined to no-op
 */
export interface WorkflowTelemetrySink {
  recordChildInvocation(
    invocation:
      import("../../domain/telemetry/command_invocation.ts").CommandInvocationData,
    startedAt: Date,
    completedAt: Date,
    error: Error | null,
    parentInvocationId: string,
    workflowContext:
      import("../../domain/telemetry/workflow_context.ts").WorkflowContextData,
  ): Promise<void>;
  readonly parentInvocationId: string;
}

export interface WorkflowRunDeps {
  workflowRepo: WorkflowRepository;
  runRepo: WorkflowRunRepository;
  repoDir: string;
  lookupWorkflow: (
    repo: WorkflowRepository,
    idOrName: string,
  ) => Promise<Workflow | null>;
  createExecutionService: (
    workflowRepo: WorkflowRepository,
    runRepo: WorkflowRunRepository,
    repoDir: string,
    catalogStore: CatalogStore,
    ephemeralRepo?: UnifiedDataRepository,
    ephemeralCatalog?: CatalogStore,
  ) => WorkflowExecutionService;
  catalogStore: CatalogStore;
  dataRepo?: UnifiedDataRepository;
  definitionRepo?: DefinitionRepository;
  telemetrySink?: WorkflowTelemetrySink;
  /**
   * supersedes matching-input suspended runs and loads the evaluated cache a
   * --last-evaluated run replays; without it nothing is superseded and the
   * execution service loads the cache itself
   */
  supersede?: SupersedeDeps;
  /**
   * reads the attributes of the run's data back from the datastore for the
   * completed event; a dep, never an input, as serve must not grant it
   */
  resolveCompletedOutputs?: boolean;
  /**
   * handed the live completed run, whose never-persisted sensitive values are
   * the only mask for its data, before the completed event is yielded; a dep,
   * never an input
   */
  onCompletedRun?: (run: WorkflowRun) => void;
}

export interface WorkflowRunInput {
  workflowIdOrName: string;
  /**
   * Treat `workflowIdOrName` as a workflow id the caller already resolved,
   * and look it up by id only — here and in the execution service — so the
   * run executes the workflow the caller authorized.
   */
  byId?: boolean;
  /**
   * With `byId`, the name the caller authorized: ids are not guaranteed
   * unique, so only a workflow with this name and the id is accepted.
   */
  expectedName?: string;
  lastEvaluated?: boolean;
  inputs?: Record<string, unknown>;
  /**
   * Verified webhook request payload, set only for webhook-triggered runs.
   * `executeWorkflowWithLocks` CEL-evaluates the workflow's `trigger.inputs`
   * against this payload to produce baseline inputs before validation.
   */
  webhook?: WebhookPayload;
  runtimeTags?: Record<string, string>;
  verbose?: boolean;
  skipAllReports?: boolean;
  skipReportNames?: string[];
  skipReportLabels?: string[];
  reportNames?: string[];
  reportLabels?: string[];
  swampSha?: string;
  skipCheckNames?: string[];
  skipCheckLabels?: string[];
  skipAllChecks?: boolean;
  traceparent?: string;
  tracestate?: string;
  assertFailOnSeverity?: AssertSeverity;
  initiatedBy?: string;
  instanceId?: string;
  triggerSource?: string;
  noSupersede?: boolean;
}

function viewStatus(
  status: WorkflowRun["jobs"][number]["status"],
): StepRunView["status"] {
  return status === "waiting_signal" ? "waiting" : status;
}

export function extractStepArtifacts(
  step: StepRun,
  resolved?: ResolvedStepOutputs,
): StepArtifactsData | undefined {
  if (step.output === undefined || step.output === null) {
    return undefined;
  }

  const output = step.output as Record<string, unknown>;

  if (
    typeof output.stdout === "string" || typeof output.exitCode === "number"
  ) {
    const artifacts: StepArtifactsData = {};
    if (output.stdout) artifacts.stdout = output.stdout as string;
    if (output.stderr) artifacts.stderr = output.stderr as string;
    if (typeof output.exitCode === "number") {
      artifacts.exitCode = output.exitCode;
    }
    return Object.keys(artifacts).length > 0 ? artifacts : undefined;
  }

  // A model method output keeps no attributes on the run record; they come
  // from the step's resolved outputs when the caller resolved them.
  if (output.type === "model_method") {
    return resolved?.outputs ? { dataAttributes: resolved.outputs } : undefined;
  }

  return undefined;
}

function mapApprovalDecision(
  decision: ApprovalDecisionData,
  stepStartedAt: Date | undefined,
): ApprovalView {
  if (decision.approved) {
    const view: ApprovalView = {
      status: "approved",
      approvedBy: decision.decidedBy,
      approvedAt: decision.decidedAt,
    };
    if (stepStartedAt) {
      const decidedMs = new Date(decision.decidedAt).getTime();
      view.approvalDuration = decidedMs - stepStartedAt.getTime();
    }
    return view;
  }
  return {
    status: "rejected",
    rejectedBy: decision.decidedBy,
    rejectedAt: decision.decidedAt,
    reason: decision.reason,
  };
}

export type RunStepOutputs = Record<
  string,
  Record<string, ResolvedStepOutputs>
>;

export async function resolveRunStepOutputs(
  run: WorkflowRun,
  resolver: StepOutputResolver,
): Promise<RunStepOutputs> {
  const resolved: RunStepOutputs = {};
  for (const job of run.jobs) {
    const steps: Record<string, ResolvedStepOutputs> = {};
    for (const step of job.steps) {
      steps[step.stepName] = await resolver.resolve(step);
    }
    resolved[job.jobName] = steps;
  }
  return resolved;
}

const runLogger = getLogger(["swamp", "workflow", "run"]);

/**
 * the attributes of a finished run's data, read from the datastore as local
 * history get reads them; a missing resource is left out, and a walk that
 * fails or is aborted gives undefined
 */
export async function resolveCompletedRunOutputs(
  run: WorkflowRun,
  dataRepo: UnifiedDataRepository,
  runRepo: WorkflowRunRepository,
  signal?: AbortSignal,
  canRead?: ResourceReadPolicy,
  readAttributes: ResourceAttributeReader = createDataRepositoryAttributeReader(
    dataRepo,
  ),
): Promise<RunStepOutputs | undefined> {
  const resolver = new StepOutputResolver({
    readAttributes,
    findChildRun: (workflowId, runId) =>
      runRepo.findById(
        createWorkflowId(workflowId),
        createWorkflowRunId(runId),
      ),
    canRead,
    namespace: dataRepo.namespace,
    signal,
  });
  try {
    return await resolveRunStepOutputs(run, resolver);
  } catch (error) {
    // The run is already saved; only its summary goes without attributes.
    runLogger.debug`Data attributes of run ${run.id} not read: ${error}`;
    return undefined;
  }
}

export interface ExecutionEventWithOutputs {
  event: WorkflowExecutionEvent;
  stepOutputs?: RunStepOutputs;
}

/**
 * holds the completed event until the source ends: the execution service saves
 * the run after yielding it, and a read before then would delay that save
 */
export async function* deferCompletedForOutputs(
  source: AsyncIterable<WorkflowExecutionEvent>,
  resolve?: (run: WorkflowRun) => Promise<RunStepOutputs | undefined>,
): AsyncGenerator<ExecutionEventWithOutputs> {
  if (!resolve) {
    for await (const event of source) yield { event };
    return;
  }
  let held: WorkflowExecutionEvent | undefined;
  try {
    for await (const event of source) {
      if (event.kind === "completed") {
        held = event;
        continue;
      }
      yield { event };
    }
  } catch (error) {
    // a run that stops with an error yields completed first, then throws
    if (held?.kind === "completed") {
      const completed = held;
      held = undefined;
      yield { event: completed, stepOutputs: await resolve(completed.run) };
    }
    throw error;
  }
  if (held?.kind === "completed") {
    yield { event: held, stepOutputs: await resolve(held.run) };
  }
}

/** placed and masked through toRunData, so the live run's sensitive values apply */
export function withRunStepOutputs(
  view: WorkflowRunView,
  run: WorkflowRun,
  stepOutputs: RunStepOutputs,
  verbose?: boolean,
): WorkflowRunView {
  const resolved = toRunData(run, view.path, verbose, stepOutputs);
  return {
    ...view,
    jobs: view.jobs.map((job) => {
      const resolvedJob = resolved.jobs.find((j) => j.name === job.name);
      if (!resolvedJob) return job;
      return {
        ...job,
        steps: job.steps.map((step) => {
          const from = resolvedJob.steps.find((s) => s.name === step.name);
          if (!from) return step;
          return {
            ...step,
            ...(from.dataArtifacts !== undefined
              ? { dataArtifacts: from.dataArtifacts }
              : {}),
            ...(from.outputs !== undefined ? { outputs: from.outputs } : {}),
            ...(from.artifacts !== undefined
              ? { artifacts: from.artifacts }
              : {}),
          };
        }),
      };
    }),
  };
}

export function toRunData(
  run: WorkflowRun,
  path?: string,
  verbose?: boolean,
  stepOutputs?: RunStepOutputs,
): WorkflowRunView {
  const startTime = run.startedAt?.getTime();
  const endTime = run.completedAt?.getTime();

  // value fields are shown through the run's one display view: recorded values
  // masked and, in a typed run, its sentinels
  const inputs = run.inputs && Object.keys(run.inputs).length > 0
    ? run.mask(run.inputs)
    : undefined;

  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    inputs,
    status: run.status,
    jobs: run.jobs.map((job) => {
      const jobStart = job.startedAt?.getTime();
      const jobEnd = job.completedAt?.getTime();

      return {
        name: job.jobName,
        status: viewStatus(job.status),
        steps: job.steps.map((step) => {
          const stepStart = step.startedAt?.getTime();
          const stepEnd = step.completedAt?.getTime();

          const stepData: StepRunView = {
            name: step.stepName,
            status: viewStatus(step.status),
            error: run.mask(step.error),
            ...(step.errorCode !== undefined
              ? { errorCode: step.errorCode }
              : {}),
            startedAt: step.startedAt?.toISOString(),
            completedAt: step.completedAt?.toISOString(),
            duration: stepStart && stepEnd ? stepEnd - stepStart : undefined,
          };

          const resolved = stepOutputs?.[job.jobName]?.[step.stepName];

          if (verbose) {
            const artifacts = extractStepArtifacts(step, resolved);
            if (artifacts) {
              stepData.artifacts = artifacts;
            }
          }

          if (step.dataArtifacts && step.dataArtifacts.length > 0) {
            stepData.dataArtifacts = step.dataArtifacts.map((a) => ({
              dataId: a.dataId,
              name: a.name,
              version: a.version,
              tags: a.tags,
              attributes: run.mask(resolved?.attributesByDataId[a.dataId]),
            }));
          }

          if (step.allowedFailure) {
            stepData.allowedFailure = true;
          }

          if (step.assertResult) {
            // Only the expression-derived text is masked: passed, expr and
            // severity are typed fields the mask would coerce.
            const assertResult = { ...step.assertResult };
            stepData.assertResult = {
              ...assertResult,
              message: run.mask(assertResult.message),
              ...(assertResult.error !== undefined
                ? { error: run.mask(assertResult.error) }
                : {}),
            };
          }

          if (step.skipReason) {
            stepData.skipReason = { ...step.skipReason };
          }

          if (step.failureKind) {
            stepData.failureKind = step.failureKind;
          }

          if (step.nestedRun?.kind === "valid") {
            stepData.nestedRun = {
              workflowId: step.nestedRun.ref.workflowId,
              workflowName: step.nestedRun.ref.workflowName,
              runId: step.nestedRun.ref.runId,
              ...(step.detachedNestedRun ? { detached: true as const } : {}),
            };
          }

          if (step.signalWait) {
            stepData.wait = {
              id: step.signalWait.id,
              deadline: step.signalWait.deadline.toISOString(),
              ...(step.signalWait.key !== undefined
                ? { key: step.signalWait.key }
                : {}),
              // as stored, heldAsPending included: the run view is the one
              // place that shows it
              ...(step.signalWait.receipt
                ? { receipt: { ...step.signalWait.receipt } }
                : {}),
            };
          }

          if (step.approvalDecision) {
            stepData.approval = mapApprovalDecision(
              step.approvalDecision,
              step.startedAt,
            );
          }

          if (resolved?.outputs) {
            stepData.outputs = run.mask(resolved.outputs);
          }

          return stepData;
        }),
        startedAt: job.startedAt?.toISOString(),
        completedAt: job.completedAt?.toISOString(),
        duration: jobStart && jobEnd ? jobEnd - jobStart : undefined,
      };
    }),
    startedAt: run.startedAt?.toISOString(),
    completedAt: run.completedAt?.toISOString(),
    duration: startTime && endTime ? endTime - startTime : undefined,
    path,
    workflowDataArtifacts: run.workflowDataArtifacts &&
        run.workflowDataArtifacts.length > 0
      ? run.workflowDataArtifacts.map((a) => ({
        dataId: a.dataId,
        name: a.name,
        version: a.version,
        tags: a.tags,
      }))
      : undefined,
    initiatedBy: run.initiatedBy,
    references: run.references,
    ...(run.parentRun?.kind === "valid"
      ? {
        parentRun: {
          workflowId: run.parentRun.ref.workflowId,
          workflowName: run.parentRun.ref.workflowName,
          runId: run.parentRun.ref.runId,
          stepName: run.parentRun.ref.stepName,
        },
      }
      : {}),
  };
}

/**
 * shared by run and resume so both emit the same WorkflowRunView envelope, not
 * the WorkflowRun class's private _status fields
 */
export function mapWorkflowExecutionEvent(
  event: WorkflowExecutionEvent,
  runRepo: WorkflowRunRepository,
  verbose?: boolean,
  stepOutputs?: RunStepOutputs,
): WorkflowRunEvent {
  switch (event.kind) {
    case "started":
      return {
        kind: "started",
        runId: event.runId,
        ...(event.parentRunId !== undefined
          ? { parentRunId: event.parentRunId }
          : {}),
        workflowName: event.workflowName,
        jobs: event.jobs.map((j) => ({
          id: j.id,
          stepCount: j.stepCount,
          dependsOn: j.dependsOn,
        })),
      };
    case "completed": {
      const path = runRepo.getPath(
        createWorkflowId(event.run.workflowId),
        createWorkflowRunId(event.run.id),
      );
      const data = toRunData(event.run, path, verbose, stepOutputs);
      return { kind: "completed", run: data };
    }
    case "cancelled": {
      const path = runRepo.getPath(
        createWorkflowId(event.run.workflowId),
        createWorkflowRunId(event.run.id),
      );
      const data = toRunData(event.run, path, verbose);
      return { kind: "cancelled", run: data, reason: event.reason };
    }
    case "suspended": {
      const path = runRepo.getPath(
        createWorkflowId(event.run.workflowId),
        createWorkflowRunId(event.run.id),
      );
      const data = toRunData(event.run, path, verbose);
      return {
        kind: "suspended",
        run: data,
        jobId: event.jobId,
        stepId: event.stepId,
        prompt: event.prompt,
        timeout: event.timeout,
        ...(event.nested ? { nested: { ...event.nested } } : {}),
        ...(event.wait ? { wait: { ...event.wait } } : {}),
        ...(event.nestedSignalWaits
          ? {
            nestedSignalWaits: event.nestedSignalWaits.map((w) => ({ ...w })),
          }
          : {}),
      };
    }
    case "step_failed": {
      // dataHandles and runId are domain-internal and errorPaths feeds only the
      // telemetry bridge; keep them off the published event
      const {
        dataHandles: _dataHandles,
        errorPaths: _errorPaths,
        runId: _runId,
        ...published
      } = event;
      return published;
    }
    case "step_completed":
    case "model_resolved":
    case "method_executing": {
      // runId names the run that owns the step, for the telemetry bridge.
      // Keep it off the published event: a remote client takes the runId of
      // any event without parentRunId as the run to reattach to.
      const { runId: _runId, ...published } = event;
      return published;
    }
    case "job_started":
    case "job_completed":
    case "job_skipped":
    case "step_started":
    case "step_skipped":
    case "approval_requested":
    case "signal_wait_requested":
    case "step_queued":
    case "step_target_disconnected":
    case "env_var_warning":
    case "method_output":
    case "method_event":
    case "assert_result":
    case "report_started":
    case "report_completed":
    case "report_failed":
      return event;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

export async function* workflowRun(
  ctx: LibSwampContext,
  deps: WorkflowRunDeps,
  input: WorkflowRunInput,
): AsyncGenerator<WorkflowRunEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorTraceContext(
      input.traceparent,
      input.tracestate,
      withGeneratorSpan(
        "swamp.workflow.run.command",
        { "workflow.id_or_name": input.workflowIdOrName },
        (async function* () {
          let resolvedInput = input;

          yield { kind: "validating_inputs" };

          const workflow = input.byId
            ? await findWorkflowById(
              deps.workflowRepo,
              input.workflowIdOrName,
              input.expectedName,
            )
            : await deps.lookupWorkflow(
              deps.workflowRepo,
              input.workflowIdOrName,
            );
          if (!workflow) {
            // A file carrying the requested name/id may exist but fail
            // schema parsing, making it invisible to the repository lookup.
            // Surface the parse error instead of a misleading "not found".
            const workflowsDir = workflowsDirFor(deps.repoDir);
            const matches = (
              file: { id: string | null; name: string | null },
            ) =>
              !input.byId ||
              (file.id === input.workflowIdOrName &&
                (input.expectedName === undefined ||
                  file.name === input.expectedName));
            const broken = await findBrokenWorkflow(
              workflowsDir,
              input.workflowIdOrName,
            );
            if (broken && matches(broken)) {
              yield {
                kind: "error",
                error: workflowLoadFailed(input.workflowIdOrName, broken),
              };
              return;
            }
            // a file declaring it under a name the loader skips explains the
            // miss
            const misnamed = await findMisnamedWorkflow(
              workflowsDir,
              input.workflowIdOrName,
            );
            yield {
              kind: "error",
              error: misnamed && matches(misnamed)
                ? workflowNotLoaded(input.workflowIdOrName, misnamed)
                : workflowNotFound(input.workflowIdOrName),
            };
            return;
          }

          if (workflow.inputs && !input.lastEvaluated) {
            const coercedInputs = coerceInputTypes(
              input.inputs ?? {},
              workflow.inputs,
            );
            const validationService = new InputValidationService();
            const inputsWithDefaults = validationService.applyDefaults(
              coercedInputs,
              workflow.inputs,
            );
            const result = validationService.validate(
              inputsWithDefaults,
              workflow.inputs,
            );
            if (!result.valid) {
              yield {
                kind: "error",
                error: inputValidationFailed(result.errors),
              };
              return;
            }
            resolvedInput = { ...input, inputs: inputsWithDefaults };
          } else if (workflow.inputs) {
            resolvedInput = {
              ...input,
              inputs: coerceInputTypes(input.inputs ?? {}, workflow.inputs),
            };
          }

          // one copy of the evaluated cache for the whole start, shared by
          // superseding and the execution service; an unreadable cache is
          // reported like any failure to start, not thrown out of the stream
          let evaluatedCache: EvaluatedWorkflowCache | null | undefined;
          if (resolvedInput.lastEvaluated && deps.supersede) {
            try {
              evaluatedCache = await deps.supersede.evaluatedCache(
                workflow.name,
              );
            } catch (error) {
              yield { kind: "error", error: workflowExecutionFailed(error) };
              return;
            }
          }
          // Undefined when the run will be refused before it starts.
          const supersedeInputs = !resolvedInput.noSupersede && deps.supersede
            ? supersedeMatchInputs(
              resolvedInput.inputs ?? {},
              resolvedInput.lastEvaluated === true,
              evaluatedCache,
            )
            : undefined;
          if (supersedeInputs && deps.supersede) {
            // a run cancelled while its suspended runs are read supersedes none
            // of them, and is recorded as cancelled by the run below
            const { cancelledRunIds, skippedRuns, ...nested } =
              await supersedeSuspendedRuns(
                workflow,
                supersedeInputs,
                deps.supersede,
                deps.runRepo,
                ctx.signal,
              );
            if (cancelledRunIds.length > 0 || skippedRuns.length > 0) {
              yield {
                kind: "superseded_runs",
                cancelledRunIds,
                ...nestedCascadeFields(nested),
                ...(skippedRuns.length > 0 ? { skippedRuns } : {}),
              };
            }
          }

          yield { kind: "evaluating_workflow" };

          // created after the input-validation early returns so the scratch
          // store is allocated only for a run that executes; disposed in the
          // finally below on every exit
          const ephemeral = createEphemeralStore(deps.dataRepo?.namespace);
          const service = deps.createExecutionService(
            deps.workflowRepo,
            deps.runRepo,
            deps.repoDir,
            deps.catalogStore,
            ephemeral.repo,
            ephemeral.catalog,
          );

          // gate service intentionally not wired: approving or rejecting
          // workflow gates from model code bypasses authorization

          // constructed once per stream consumption and finalized in the outer
          // finally, so in-flight invocations on cancellation or throw are
          // recorded as error child entries
          const telemetryBridge = deps.telemetrySink
            ? new WorkflowTelemetryBridge(deps.telemetrySink)
            : undefined;

          try {
            // all report_completed and report_failed events, method- and
            // workflow-scope, arrive before the completed event, so the
            // accumulated list is attached there
            const reportResults: ReportResultView[] = [];
            const outputsRepo = deps.resolveCompletedOutputs
              ? deps.dataRepo
              : undefined;

            for await (
              const { event, stepOutputs } of deferCompletedForOutputs(
                service.run(resolvedInput.workflowIdOrName, {
                  byId: resolvedInput.byId,
                  expectedName: resolvedInput.expectedName,
                  lastEvaluated: resolvedInput.lastEvaluated,
                  evaluatedCache: evaluatedCache ?? undefined,
                  inputs: resolvedInput.inputs,
                  runtimeTags: resolvedInput.runtimeTags,
                  signal: ctx.signal,
                  reportFilterOptions: {
                    skipAllReports: resolvedInput.skipAllReports,
                    skipReportNames: resolvedInput.skipReportNames,
                    skipReportLabels: resolvedInput.skipReportLabels,
                    reportNames: resolvedInput.reportNames,
                    reportLabels: resolvedInput.reportLabels,
                  },
                  swampSha: resolvedInput.swampSha,
                  skipCheckNames: resolvedInput.skipCheckNames,
                  skipCheckLabels: resolvedInput.skipCheckLabels,
                  skipAllChecks: resolvedInput.skipAllChecks,
                  assertFailOnSeverity: resolvedInput.assertFailOnSeverity,
                  initiatedBy: resolvedInput.initiatedBy,
                  instanceId: resolvedInput.instanceId,
                  triggerSource: resolvedInput.triggerSource,
                }),
                outputsRepo || deps.onCompletedRun
                  ? (run) => {
                    deps.onCompletedRun?.(run);
                    return outputsRepo
                      ? resolveCompletedRunOutputs(
                        run,
                        outputsRepo,
                        deps.runRepo,
                        ctx.signal,
                      )
                      : Promise.resolve(undefined);
                  }
                  : undefined,
              )
            ) {
              if (event.kind === "report_completed") {
                reportResults.push({
                  name: event.reportName,
                  scope: event.scope,
                  success: true,
                  markdown: event.markdown,
                  json: event.json,
                });
              } else if (event.kind === "report_failed") {
                reportResults.push({
                  name: event.reportName,
                  scope: event.scope,
                  success: false,
                  error: event.error,
                });
              }

              let mapped = mapWorkflowExecutionEvent(
                event,
                deps.runRepo,
                resolvedInput.verbose,
                stepOutputs,
              );

              // takes the domain event: pairing a step's events needs the
              // owning run's id, which the mapped event omits
              if (telemetryBridge) {
                await telemetryBridge.observe(event);
              }

              if (
                (mapped.kind === "completed" || mapped.kind === "cancelled" ||
                  mapped.kind === "suspended") &&
                reportResults.length > 0
              ) {
                mapped = {
                  ...mapped,
                  run: { ...mapped.run, reports: reportResults },
                };
              }

              yield mapped;
            }
          } catch (error) {
            if (
              error instanceof DOMException && error.name === "AbortError"
            ) {
              yield { kind: "error", error: cancelled(error) };
              return;
            }
            yield {
              kind: "error",
              error: workflowExecutionFailed(error),
            };
          } finally {
            // runs on every stream termination so methods that started but
            // never got a terminal event still reach telemetry
            if (telemetryBridge) {
              await telemetryBridge.finalize();
            }
            ephemeral.dispose();
          }
        })(),
      ),
    ));
}

export function workflowNotFound(idOrName: string): SwampError {
  return {
    code: "workflow_not_found",
    message: `Workflow not found: ${idOrName}.\n` +
      `Create it with 'swamp workflow create ${idOrName}', ` +
      `or run 'swamp doctor workflows --json' to check for broken workflow files`,
  };
}

export function workflowNotLoaded(
  idOrName: string,
  misnamed: Pick<MisnamedWorkflow, "message">,
): SwampError {
  return {
    code: "workflow_not_found",
    message: `Workflow not found: ${idOrName}.\n${misnamed.message}`,
  };
}

export function workflowLoadFailed(
  idOrName: string,
  broken: { file: string; error: string },
): SwampError {
  const message = `Workflow '${idOrName}' exists but failed to load: ` +
    `${broken.error}\n(file: ${broken.file})`;
  return {
    code: "workflow_load_failed",
    message,
    // marks the file so telemetry removes it exactly
    cause: markErrorPaths(new Error(message), [broken.file]),
  };
}

export function inputValidationFailed(
  errors: InputValidationError[],
): SwampError {
  const messages = errors.map((e) => `  ${e.message}`).join("\n");
  return {
    code: "input_validation_failed",
    message: `Input validation failed:\n${messages}`,
    details: errors,
  };
}

export function workflowExecutionFailed(cause: unknown): SwampError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    code: "workflow_execution_failed",
    message: `Workflow execution failed: ${message}`,
    cause: cause instanceof Error ? cause : undefined,
  };
}

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

/**
 * Delivers a signal to a wait for a caller of `swamp serve`.
 *
 * The WebSocket `workflow.signal` request and the HTTP signal route both
 * call this, so a signal is authorized, delivered, answered and audited the
 * same way whichever way it arrived. It decides who the caller is and what
 * they may learn; whether the wait accepts the signal is decided by
 * `workflowSignal`, the one acceptance use case.
 */

import { consumeStream } from "../libswamp/stream.ts";
import {
  createWorkflowSignalDeps,
  signalRefusalKind,
  type SignalWaitSubject,
  workflowSignal,
  type WorkflowSignalData,
  type WorkflowSignalEvent,
} from "../libswamp/workflows/signal.ts";
import type { AccessResource } from "../domain/access/access_decision_service.ts";
import { principalToString } from "../domain/access/principal.ts";
import { resolveActorIdentity } from "../domain/serve_audit/actor_identity.ts";
import { buildAuditEvent } from "../domain/serve_audit/audit_event_builder.ts";
import { SIGNAL_PAYLOAD_MAX_BYTES } from "../domain/workflows/signal_wait.ts";
import type { SignalReceipt } from "../domain/workflows/signal_wait.ts";
import { normalizeWaitId } from "../domain/workflows/signal_wait_records.ts";
import { SIGNAL_WAITS_NOT_CONFIGURED } from "../domain/workflows/signal_wait_store.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  type AccessCaller,
  callerResourceDecider,
  type ConnectionContext,
  type DecisionSubject,
  handlerLibSwampContext,
  isCallerAuthorized,
  resolveDisplayPrincipal,
  sanitizeErrorForClient,
} from "./handlers/shared.ts";
import {
  canonicalResources,
  resolveWorkflowTargetById,
} from "./handlers/resource_resolution.ts";
import type { WorkflowSignalResponseData } from "./protocol.ts";
import { continueSettledRun } from "./resume_launcher.ts";
import { withSyncGate } from "./sync_gate.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../domain/workflows/workflow_id.ts";

const logger = getSwampLogger(["serve", "signal"]);

/** A signal as a caller sent it. Both fields are untrusted. */
export interface SignalDeliveryRequest {
  /** Identifies the request in audit events. */
  readonly requestId: string;
  readonly waitId: string;
  readonly payload: unknown;
}

/** A refusal other than "not found" or a refused payload. */
export type SignalRefusalStatus =
  | "expired"
  | "already_settled"
  | "closed"
  | "unreadable"
  | "unsupported";

/** How a signal was answered. Everything in it may be sent to the caller. */
export type SignalDeliveryResult =
  | {
    readonly status: "delivered";
    readonly data: WorkflowSignalResponseData;
    /**
     * The run the wait belongs to, for the server's own use: it is never
     * sent to the caller, who is told the run only in `data` and only when
     * they may read the workflow. `recordAvailable` is false when this
     * instance has no record of the run.
     */
    readonly run: {
      readonly workflowId: string;
      readonly runId: string;
      readonly recordAvailable: boolean;
    };
  }
  /** An unknown wait ID, or a wait the caller may not signal. */
  | { readonly status: "not_found"; readonly message: string }
  | {
    readonly status: "invalid_payload";
    readonly message: string;
    readonly errors: readonly string[];
  }
  | {
    readonly status: SignalRefusalStatus;
    readonly message: string;
    /** The earlier signal, for a caller who may read the workflow. */
    readonly receipt?: SignalReceipt;
  }
  | { readonly status: "failed"; readonly message: string };

/** The one answer for a wait the caller cannot be told about. */
export const SIGNAL_WAIT_NOT_FOUND_MESSAGE = "Signal wait not found";

/** What a caller who may not read the workflow is told of each refusal. */
const GENERIC_REFUSAL: Record<SignalRefusalStatus, string> = {
  expired: "The wait has expired and no longer accepts a signal.",
  already_settled: "The wait is already settled.",
  closed: "The wait was closed before a signal arrived.",
  unreadable:
    "The wait's stored record cannot be read, so no signal can be delivered to it.",
  unsupported: "This server's datastore cannot hold waits for a signal.",
};

const NOT_FOUND: SignalDeliveryResult = {
  status: "not_found",
  message: SIGNAL_WAIT_NOT_FOUND_MESSAGE,
};

/** True when `payload` serialises to more than a wait accepts. */
function payloadTooLarge(payload: unknown): boolean {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return true;
  }
  return serialized !== undefined &&
    new TextEncoder().encode(serialized).length > SIGNAL_PAYLOAD_MAX_BYTES;
}

/**
 * The workflows a wait belongs to, as resources to authorize. Empty when the
 * wait cannot be tied to a workflow, which refuses the caller.
 */
async function ownersOf(
  ctx: ConnectionContext,
  wait: SignalWaitSubject,
): Promise<AccessResource[]> {
  if (wait.workflowName !== undefined) {
    return await canonicalResources(ctx).workflowOwners(
      wait.workflowId,
      wait.workflowName,
    );
  }
  // Only the wait's outcome is left and the run record is gone too, so the
  // workflow is known by id alone.
  const resolution = await resolveWorkflowTargetById(
    ctx.repoContext.workflowRepo,
    wait.workflowId,
  );
  return resolution.status === "found" ? [resolution.resource] : [];
}

/**
 * Delivers `request` for `caller`. The caller needs `signal` on every
 * workflow the wait belongs to; without it, or for a wait that does not
 * exist, the answer is `not_found` and nothing else. The workflow, run and
 * step, the run's state and an earlier signal's receipt are given only to a
 * caller who may also `read` those workflows.
 *
 * Nothing is written but the wait's outcome record: no run is saved, no
 * claim or reservation is taken and nothing is pushed. Continuing the run
 * is the caller's next step (see {@link continueAfterSignal}).
 */
export async function deliverSignalForCaller(
  ctx: ConnectionContext,
  caller: AccessCaller,
  request: SignalDeliveryRequest,
): Promise<SignalDeliveryResult> {
  const waitId = normalizeWaitId(request.waitId);
  if (waitId === undefined) return NOT_FOUND;
  if (payloadTooLarge(request.payload)) {
    return {
      status: "invalid_payload",
      message:
        `Payload refused: it is over the ${SIGNAL_PAYLOAD_MAX_BYTES} byte limit.`,
      errors: [`payload is over the ${SIGNAL_PAYLOAD_MAX_BYTES} byte limit`],
    };
  }

  let readable = false;
  const authorize = async (wait: SignalWaitSubject): Promise<boolean> => {
    // Catches a registration whose workflow name was changed. One whose
    // workflow ID was changed finds no run record, so nothing is compared;
    // a writer who can do that can also create the outcome directly.
    const recorded = wait.runWorkflow;
    if (
      recorded && (recorded.workflowId !== wait.workflowId ||
        (wait.workflowName !== undefined &&
          recorded.workflowName !== wait.workflowName))
    ) {
      logger.warn(
        "Signal for wait {waitId} refused: its stored record names workflow {registered}, but run {runId} belongs to {recorded}",
        {
          waitId,
          registered: wait.workflowName ?? wait.workflowId,
          runId: wait.runId,
          recorded: recorded.workflowName,
        },
      );
      return false;
    }
    let owners: AccessResource[];
    try {
      owners = await ownersOf(ctx, wait);
    } catch (error) {
      logger.warn(
        "Signal for wait {waitId} refused: its workflow could not be resolved: {error}",
        {
          waitId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return false;
    }
    if (owners.length === 0) return false;
    for (const owner of owners) {
      if (
        !isCallerAuthorized(caller, request.requestId, "signal", owner, ctx)
      ) return false;
    }
    const mayRead = callerResourceDecider(caller, "read", ctx);
    readable = owners.every(mayRead);
    return true;
  };

  const deps = {
    ...createWorkflowSignalDeps(
      ctx.repoContext.workflowRunRepo,
      ctx.repoContext.signalWaits ?? SIGNAL_WAITS_NOT_CONFIGURED,
    ),
    // One request must not make serve read every run record.
    scanRunRecords: false,
  };

  let result: SignalDeliveryResult | undefined;
  let delivered: WorkflowSignalData | undefined;
  try {
    await consumeStream<WorkflowSignalEvent>(
      workflowSignal(handlerLibSwampContext(ctx), deps, {
        waitId,
        payload: request.payload,
        // With authorization off there is no principal, and the use case
        // records the serve process's user, as a local signal does.
        ...(caller.principal
          ? { submittedBy: principalToString(caller.principal) }
          : {}),
        authorize,
      }),
      {
        resolving: () => {},
        completed: (event) => {
          delivered = event.data;
        },
        error: (event) => {
          const kind = signalRefusalKind(event.error);
          if (kind === undefined) {
            result = {
              status: "failed",
              message: sanitizeErrorForClient(new Error(event.error.message)),
            };
          } else if (kind === "unknown") {
            result = NOT_FOUND;
          } else if (kind === "invalid_payload") {
            const details = event.error.details as { errors?: unknown };
            const errors = Array.isArray(details?.errors)
              ? details.errors.filter((e): e is string => typeof e === "string")
              : [];
            result = {
              status: "invalid_payload",
              message: "Payload refused; the wait stays open:\n" +
                errors.map((error) => `  - ${error}`).join("\n"),
              errors,
            };
          } else {
            const receipt = readable && kind === "already_settled"
              ? (event.error.details as { receipt?: SignalReceipt }).receipt
              : undefined;
            result = {
              status: kind,
              message: readable
                ? sanitizeErrorForClient(new Error(event.error.message))
                : GENERIC_REFUSAL[kind],
              ...(receipt ? { receipt: { ...receipt } } : {}),
            };
          }
        },
      },
    );
  } catch (error) {
    logger.warn("Signal for wait {waitId} failed: {error}", {
      waitId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "failed", message: "Signal delivery failed" };
  }

  if (delivered === undefined) {
    return result ?? { status: "failed", message: "Signal delivery failed" };
  }

  emitDelivered(ctx, caller, request.requestId, delivered);
  return {
    status: "delivered",
    run: {
      workflowId: delivered.workflowId,
      runId: delivered.runId,
      recordAvailable: delivered.runRecordAvailable,
    },
    data: {
      waitId: delivered.waitId,
      signal: { ...delivered.signal },
      ...(readable
        ? {
          workflowId: delivered.workflowId,
          workflowName: delivered.workflowName,
          runId: delivered.runId,
          jobName: delivered.jobName,
          stepName: delivered.stepName,
          awaitingResume: delivered.awaitingResume,
          runRecordAvailable: delivered.runRecordAvailable,
          resumeCommand: delivered.resumeCommand,
        }
        : {}),
    },
  };
}

/**
 * Audits a delivered signal with its receipt. The payload is never recorded:
 * it is untrusted data for the run, not a fact about the request.
 */
function emitDelivered(
  ctx: ConnectionContext,
  caller: AccessCaller,
  requestId: string,
  delivered: WorkflowSignalData,
): void {
  if (!ctx.auditEmitter) return;
  const { principal } = caller;
  ctx.auditEmitter.emit(buildAuditEvent({
    instanceId: ctx.instanceId ?? "unknown",
    category: "execution",
    stage: "response",
    outcome: "success",
    action: "workflow.signal.delivered",
    resourceKind: "workflow",
    resourceName: delivered.workflowName,
    principalKind: principal?.kind ?? "anonymous",
    principalId: principal?.id ?? "anonymous",
    initiatedBy: principal ? resolveDisplayPrincipal(principal, ctx) : "ghost",
    actor: resolveActorIdentity(
      principal,
      ctx.resolvedUserNames,
      caller.loginIdentity,
    ),
    sourceIp: caller.sourceIp,
    requestId,
    detail:
      `wait=${delivered.waitId} receipt=${delivered.signal.id} run=${delivered.runId}`,
  }));
}

/**
 * Tries to continue the run a delivered signal belongs to, now that one
 * more of its waits is settled (swamp-club#3108). The WebSocket handler
 * calls it after sending its reply; the HTTP route before building its own,
 * which waits only for the launch, not for the run. Never throws: the signal is stored, and the continuation
 * sweep retries whatever is not launched here.
 */
export async function continueAfterSignal(
  ctx: ConnectionContext,
  result: SignalDeliveryResult,
  subject: DecisionSubject,
): Promise<void> {
  if (result.status !== "delivered") return;
  try {
    if (!result.run.recordAvailable) await hydrateMissingRun(ctx, result.run);
    await continueSettledRun(ctx, result.run, {
      kind: "signal",
      principalId: subject.principal
        ? principalToString(subject.principal)
        : null,
      subject,
      // This instance's copy of the run is not known to be current, so a
      // dead holder's claim is left to the sweep.
      takeover: false,
    });
  } catch (error) {
    logger.warn(
      "Could not continue run {runId} after its signal: {error}",
      {
        runId: result.run.runId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

/**
 * Fetches the record of a run this instance does not have, from a datastore
 * whose run records are synced. Only a record that is missing is fetched:
 * one that is here may hold a change not pushed yet, which a download would
 * overwrite. Taken under the sync gate, so no handler's delete of the run
 * is between its removal and its push.
 */
async function hydrateMissingRun(
  ctx: ConnectionContext,
  run: { workflowId: string; runId: string },
): Promise<void> {
  const hydrate = ctx.repoContext.hydrateFile;
  if (!hydrate) return;
  const runRepo = ctx.repoContext.workflowRunRepo;
  const workflowId = createWorkflowId(run.workflowId);
  const runId = createWorkflowRunId(run.runId);
  await withSyncGate(ctx.syncGate, async () => {
    if (await runRepo.findById(workflowId, runId)) return;
    await hydrate(runRepo.getPath(workflowId, runId));
  });
}

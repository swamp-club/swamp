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
 * the WebSocket and HTTP signal routes both call this so a signal is
 * authorized, delivered, answered and audited the same way; it decides who the
 * caller is and what they learn, workflowSignal decides acceptance
 */

import { consumeStream } from "../libswamp/stream.ts";
import {
  createWorkflowSignalDeps,
  type PendingSignalReceipt,
  type SignalLastWait,
  signalLastWait,
  signalRefusalKind,
  type SignalWaitSubject,
  workflowSignal,
  type WorkflowSignalData,
  type WorkflowSignalEvent,
  type WorkflowSignalPendingData,
} from "../libswamp/workflows/signal.ts";
import type { AccessResource } from "../domain/access/access_decision_service.ts";
import { principalToString } from "../domain/access/principal.ts";
import { resolveActorIdentity } from "../domain/serve_audit/actor_identity.ts";
import { buildAuditEvent } from "../domain/serve_audit/audit_event_builder.ts";
import {
  isWaitKey,
  SIGNAL_PAYLOAD_MAX_BYTES,
  SIGNAL_WORKFLOW_MAX_LENGTH,
} from "../domain/workflows/signal_wait.ts";
import type { SignalReceipt } from "../domain/workflows/signal_wait.ts";
import { normalizeWaitId } from "../domain/workflows/signal_wait_records.ts";
import { SIGNAL_WAITS_NOT_CONFIGURED } from "../domain/workflows/signal_wait_store.ts";
import { declaredEarlyWait } from "../domain/workflows/early_signal.ts";
import type { Workflow } from "../domain/workflows/workflow.ts";
import { findWorkflowById } from "../domain/workflows/workflow_lookup.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  type AccessCaller,
  callerResourceDecider,
  type ConnectionContext,
  type DecisionSubject,
  emitSystemAuditEvent,
  handlerLibSwampContext,
  isCallerAuthorized,
  resolveDisplayPrincipal,
  sanitizeErrorForClient,
} from "./handlers/shared.ts";
import {
  canonicalResources,
  resolveWorkflowTarget,
  resolveWorkflowTargetById,
  unresolvedAccessResource,
  workflowAccessResource,
} from "./handlers/resource_resolution.ts";
import type {
  WorkflowSignalAcceptedResponseData,
  WorkflowSignalPendingResponseData,
  WorkflowSignalResponseData,
} from "./protocol.ts";
import { SERVER_WAITS_COMMAND } from "./protocol.ts";
import { continueSettledRun } from "./resume_launcher.ts";
import { withSyncGate } from "./sync_gate.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../domain/workflows/workflow_id.ts";

const logger = getSwampLogger(["serve", "signal"]);

/**
 * How long the download of a missing run record may take. It is made under
 * the sync gate, so it must not outlast a stalled connection.
 */
export const RUN_RECORD_HYDRATE_TIMEOUT_MS = 30_000;

export type SignalDeliveryAddress =
  | { readonly waitId: string }
  | {
    readonly workflow: string;
    readonly key: string;
  };

export type SignalDeliveryRequest = SignalDeliveryAddress & {
  readonly requestId: string;
  readonly payload: unknown;
  /**
   * false for a caller that cannot read a pending answer: a key signal with no
   * open wait is refused no_open_wait and never held. Defaults to true.
   */
  readonly holdEarly?: boolean;
  /**
   * false for a caller that cannot read an accepted answer: where that is the
   * only answer allowed, the signal is refused upgrade_required before any wait
   * is looked for. Defaults to true.
   */
  readonly acceptsReceipt?: boolean;
  /**
   * The sender's idempotency key, already in the form of one. A signal
   * whose key matches one already received is answered with that signal.
   */
  readonly idempotencyKey?: string;
};

export interface SignalDeliveryHooks {
  /**
   * the canonical workflow name, as soon as a key address resolves and whatever
   * is then decided, so the transport audits the request and the denial under
   * one resource. Never sent to the caller.
   */
  readonly onWorkflowResolved?: (name: string) => void;
}

export type SignalRefusalStatus =
  | "no_open_wait"
  | "expired"
  | "already_settled"
  | "already_pending"
  | "closed"
  | "unreadable"
  | "unsupported";

export type SignalDeliveryResult =
  | {
    readonly status: "delivered";
    readonly data: WorkflowSignalResponseData;
    /**
     * for the server's own use, never sent to the caller, who learns the run
     * only in data and only when they may read the workflow. recordAvailable is
     * false when this instance has no record of the run
     */
    readonly run: {
      readonly workflowId: string;
      readonly runId: string;
      readonly recordAvailable: boolean;
    };
  }
  /**
   * by key: held as the key's pending signal. No wait or run took it, so no run
   * is continued.
   */
  | {
    readonly status: "pending";
    readonly data: WorkflowSignalPendingResponseData;
    /**
     * The workflow the signal is held for, for the server's own use: the
     * caller is told it only in `data`, and only when they may read it.
     */
    readonly workflow: { readonly id: string; readonly name: string };
  }
  /**
   * by key, for a caller who may not read the workflow, on a step with
   * acceptEarly: the receipt alone whether a wait took the signal or it is
   * held, so the answer does not reveal if a run is waiting
   */
  | {
    readonly status: "accepted";
    readonly data: WorkflowSignalAcceptedResponseData;
    readonly workflow: { readonly id: string; readonly name: string };
    readonly run?: {
      readonly workflowId: string;
      readonly runId: string;
      readonly recordAvailable: boolean;
    };
  }
  | { readonly status: "upgrade_required"; readonly message: string }
  | { readonly status: "not_found"; readonly message: string }
  | {
    readonly status: "invalid_payload";
    readonly message: string;
    readonly errors: readonly string[];
  }
  | {
    readonly status: SignalRefusalStatus;
    readonly message: string;
    readonly receipt?: SignalReceipt;
    readonly pending?: {
      readonly heldUntil: string;
      readonly receipt?: PendingSignalReceipt;
    };
    /**
     * with no_open_wait: the wait that last held the key and how it settled, so
     * a retrying sender can tell a landed signal from a run that has not
     * reached its wait. Its receipt is for callers who may read it
     */
    readonly lastWait?: SignalLastWait;
  }
  | { readonly status: "failed"; readonly message: string };

export const SIGNAL_WAIT_NOT_FOUND_MESSAGE = "Signal wait not found";

const GENERIC_REFUSAL: Record<SignalRefusalStatus, string> = {
  no_open_wait:
    "No open wait holds that key, so the signal was not delivered and nothing was stored.",
  expired: "The wait has expired and no longer accepts a signal.",
  already_settled: "The wait is already settled.",
  already_pending:
    "A signal is already pending for that key, so this one was not stored.",
  closed: "The wait was closed before a signal arrived.",
  unreadable:
    "The wait's stored record cannot be read, so no signal can be delivered to it.",
  unsupported: "This server's datastore cannot hold waits for a signal.",
};

/**
 * how and when the last wait settled, never by which signal, so a client
 * showing only the message can set the time against its own attempt: the same
 * refusal reaches a sender who landed and one who is early
 */
function genericLastWait(last: SignalLastWait): string {
  switch (last.settledAs) {
    case "accepted":
      return ` The last wait under the key was settled by a signal at ${last.settledAt}. A signal you sent at about that time has landed; one meant for a later run is early.`;
    case "timed_out":
      return ` The last wait under the key expired unsignalled at ${last.settledAt}.`;
    case "cancelled":
      return ` The last wait under the key was closed at ${last.settledAt}, before a signal arrived.`;
  }
}

/**
 * the same sentence whether or not a wait is open: it is decided before one is
 * looked for
 */
export const SIGNAL_UPGRADE_REQUIRED_MESSAGE =
  "This server answers a signal for that key with a receipt this client cannot read, so the signal was not delivered and nothing was stored. Upgrade swamp here and send it again.";

function acceptedData(
  signal: {
    id: string;
    receivedAt: string;
    submittedBy: string;
    idempotencyKey?: string;
  },
  duplicate: boolean | undefined,
): WorkflowSignalAcceptedResponseData {
  return {
    signal: {
      id: signal.id,
      receivedAt: signal.receivedAt,
      submittedBy: signal.submittedBy,
      ...(signal.idempotencyKey !== undefined
        ? { idempotencyKey: signal.idempotencyKey }
        : {}),
    },
    ...(duplicate ? { duplicate: true as const } : {}),
  };
}

const NOT_FOUND: SignalDeliveryResult = {
  status: "not_found",
  message: SIGNAL_WAIT_NOT_FOUND_MESSAGE,
};

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

interface AuthorizedKeyTarget {
  readonly id: string;
  readonly name: string;
  readonly readable: boolean;
}

/**
 * caller needs signal on every workflow sharing the named one's ID, since key
 * claims are per ID and copies share it; otherwise no_open_wait versus
 * not_found would reveal whether the original has an open wait
 */
async function authorizeKeyTarget(
  ctx: ConnectionContext,
  caller: AccessCaller,
  requestId: string,
  workflow: string,
  hooks: SignalDeliveryHooks,
): Promise<AuthorizedKeyTarget | SignalDeliveryResult> {
  const resolution = await resolveWorkflowTarget(
    ctx.repoContext.workflowRepo,
    workflow,
  );
  const resource = resolution.status === "failed"
    ? unresolvedAccessResource("workflow", workflow)
    : resolution.resource;
  if (resolution.status === "found") {
    hooks.onWorkflowResolved?.(resolution.name);
  }
  if (!isCallerAuthorized(caller, requestId, "signal", resource, ctx)) {
    return NOT_FOUND;
  }
  if (resolution.status === "failed") {
    logger.warn("Signal by key refused: its workflow lookup failed: {error}", {
      error: resolution.error instanceof Error
        ? resolution.error.message
        : String(resolution.error),
    });
    return { status: "failed", message: "Signal delivery failed" };
  }
  if (resolution.status !== "found") return NOT_FOUND;

  // Asked only of a caller who may signal the workflow they named: one
  // listing of the workflow files, never of runs. A repository that can
  // find the workflows with an ID without building every workflow is asked
  // for just those.
  let sharing: AccessResource[];
  try {
    const repo = ctx.repoContext.workflowRepo;
    const sameId = repo.findAllById
      ? await repo.findAllById(createWorkflowId(resolution.id))
      : (await repo.findAll()).filter((other) => other.id === resolution.id);
    sharing = sameId
      .filter((other) =>
        other.id === resolution.id && other.name !== resolution.name
      )
      .map(workflowAccessResource);
  } catch (error) {
    logger.warn(
      "Signal by key refused: workflows could not be listed: {error}",
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return { status: "failed", message: "Signal delivery failed" };
  }
  for (const other of sharing) {
    if (!isCallerAuthorized(caller, requestId, "signal", other, ctx)) {
      return NOT_FOUND;
    }
  }
  const mayRead = callerResourceDecider(caller, "read", ctx);
  return {
    id: resolution.id,
    name: resolution.name,
    readable: mayRead(resolution.resource) && sharing.every(mayRead),
  };
}

/**
 * needs signal on every workflow the wait belongs to, else not_found; details
 * go only to callers who may also read. A key address is authorized twice,
 * before and after resolving. Only the outcome is written.
 */
export async function deliverSignalForCaller(
  ctx: ConnectionContext,
  caller: AccessCaller,
  request: SignalDeliveryRequest,
  hooks: SignalDeliveryHooks = {},
): Promise<SignalDeliveryResult> {
  const result = await deliverSignal(ctx, caller, request, hooks);
  return result.status === "not_found"
    ? { status: "not_found", message: notFoundMessage(request) }
    : result;
}

/**
 * names the address as the caller sent it, whether the wait is absent or not
 * theirs to signal, so it tells them nothing they did not send
 */
function notFoundMessage(request: SignalDeliveryRequest): string {
  const address = "waitId" in request
    ? printable(request.waitId)
    : `key "${printable(request.key)}" of workflow "${
      printable(request.workflow)
    }"`;
  return `${SIGNAL_WAIT_NOT_FOUND_MESSAGE}: ${address}`;
}

function printable(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

async function deliverSignal(
  ctx: ConnectionContext,
  caller: AccessCaller,
  request: SignalDeliveryRequest,
  hooks: SignalDeliveryHooks,
): Promise<SignalDeliveryResult> {
  const waitId = "waitId" in request
    ? normalizeWaitId(request.waitId)
    : undefined;
  if ("waitId" in request && waitId === undefined) return NOT_FOUND;
  if (payloadTooLarge(request.payload)) {
    return {
      status: "invalid_payload",
      message:
        `Payload refused: it is over the ${SIGNAL_PAYLOAD_MAX_BYTES} byte limit.`,
      errors: [`payload is over the ${SIGNAL_PAYLOAD_MAX_BYTES} byte limit`],
    };
  }

  let named = waitId !== undefined ? `wait ${waitId}` : "a key";
  let keyTarget: AuthorizedKeyTarget | undefined;
  if (!("waitId" in request)) {
    if (
      request.workflow.length === 0 ||
      request.workflow.length > SIGNAL_WORKFLOW_MAX_LENGTH
    ) return NOT_FOUND;
    const target = await authorizeKeyTarget(
      ctx,
      caller,
      request.requestId,
      request.workflow,
      hooks,
    );
    if ("status" in target) return target;
    // A string that is not in the form of a key is one no step declares.
    if (!isWaitKey(request.key)) return NOT_FOUND;
    keyTarget = target;
    named = `key ${request.key} of workflow ${target.name}`;
  }

  // By key the definition is read once, here: the use case is handed this
  // workflow, so the reply's shape and what is done with the signal are
  // decided from the same definition.
  let keyWorkflow: Workflow | null = null;
  let receiptOnly = false;
  if (keyTarget && !("waitId" in request)) {
    try {
      keyWorkflow = await findWorkflowById(
        ctx.repoContext.workflowRepo,
        keyTarget.id,
        keyTarget.name,
      );
    } catch (error) {
      logger.warn("Signal for {address} failed: {error}", {
        address: named,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: "failed", message: "Signal delivery failed" };
    }
    receiptOnly = !keyTarget.readable && keyWorkflow !== null &&
      declaredEarlyWait(keyWorkflow, request.key) !== undefined;
    if (receiptOnly && request.acceptsReceipt === false) {
      return {
        status: "upgrade_required",
        message: SIGNAL_UPGRADE_REQUIRED_MESSAGE,
      };
    }
  }

  // By key the caller is a reader only if they may read the workflow they
  // named and every workflow the wait belongs to.
  let readable = keyTarget?.readable ?? false;
  const authorize = async (wait: SignalWaitSubject): Promise<boolean> => {
    // Unreachable while the use case holds a key's wait to the workflow it
    // was resolved under; checked here so that does not rest on it alone.
    if (keyTarget && wait.workflowId !== keyTarget.id) return false;
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
          waitId: wait.waitId,
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
          waitId: wait.waitId,
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
    readable = (keyTarget?.readable ?? true) && owners.every(mayRead);
    return true;
  };

  const deps = {
    ...createWorkflowSignalDeps(
      ctx.repoContext.workflowRunRepo,
      ctx.repoContext.signalWaits ?? SIGNAL_WAITS_NOT_CONFIGURED,
      ctx.repoContext.workflowRepo,
    ),
    // One request must not make serve read every run record.
    scanRunRecords: false,
    // By key the use case acts on the workflow that was authorized: found
    // by its id and accepted only under the authorized name, so neither a
    // workflow named with that id nor a copy that shares it is reached.
    ...(keyTarget ? { findWorkflow: () => Promise.resolve(keyWorkflow) } : {}),
  };
  const address = "waitId" in request
    ? { waitId: waitId! }
    : { workflow: request.workflow, key: request.key };

  let result: SignalDeliveryResult | undefined;
  let delivered: WorkflowSignalData | undefined;
  let held: WorkflowSignalPendingData | undefined;
  try {
    await consumeStream<WorkflowSignalEvent>(
      workflowSignal(handlerLibSwampContext(ctx), deps, {
        ...address,
        payload: request.payload,
        // With authorization off there is no principal, and the use case
        // records the serve process's user, as a local signal does.
        ...(caller.principal
          ? { submittedBy: principalToString(caller.principal) }
          : {}),
        authorize,
        waitsCommand: SERVER_WAITS_COMMAND,
        ...("waitId" in request && request.waitId !== waitId
          ? { typedWaitId: request.waitId }
          : {}),
        // A caller answered with the receipt alone is never refused for
        // want of an open wait: that refusal would say none is open.
        ...(request.holdEarly === false && !receiptOnly
          ? { holdEarly: false }
          : {}),
        ...(request.idempotencyKey !== undefined
          ? { idempotencyKey: request.idempotencyKey }
          : {}),
      }),
      {
        resolving: () => {},
        completed: (event) => {
          delivered = event.data;
        },
        pending: (event) => {
          held = event.data;
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
            // the sender's own address, named to a reader as the local
            // command names it
            const forReader = !readable
              ? ""
              : "waitId" in request
              ? ` for wait ${printable(request.waitId)}`
              : ` for key "${printable(request.key)}" of workflow "${
                printable(request.workflow)
              }"`;
            const errors = Array.isArray(details?.errors)
              ? details.errors.filter((e): e is string => typeof e === "string")
              : [];
            result = {
              status: "invalid_payload",
              // An early signal has no wait to stay open. A caller answered
              // with the receipt alone is not told which it was.
              message: (receiptOnly
                ? "Payload refused:\n"
                : (details as { early?: unknown })?.early === true
                ? `Payload refused${forReader}; nothing was stored:\n`
                : `Payload refused${forReader}; the wait stays open:\n`) +
                errors.map((error) =>
                  `  - ${error}`
                ).join("\n"),
              errors,
            };
          } else {
            const receipt = readable && kind === "already_settled"
              ? (event.error.details as { receipt?: SignalReceipt }).receipt
              : undefined;
            // Neither is given to a caller answered with the receipt alone:
            // when a signal stops being held, and how the key's last wait
            // was settled, are facts about the workflow's runs.
            const last = kind === "no_open_wait" && !receiptOnly
              ? signalLastWait(event.error)
              : undefined;
            const earlier = kind === "already_pending" && !receiptOnly
              ? event.error.details as {
                receipt?: PendingSignalReceipt;
                heldUntil?: string;
              }
              : undefined;
            result = {
              status: kind,
              message: readable
                ? sanitizeErrorForClient(new Error(event.error.message))
                : GENERIC_REFUSAL[kind] +
                  (last ? genericLastWait(last) : ""),
              ...(receipt ? { receipt: { ...receipt } } : {}),
              ...(earlier?.heldUntil !== undefined
                ? {
                  pending: {
                    heldUntil: earlier.heldUntil,
                    ...(readable && earlier.receipt
                      ? { receipt: { ...earlier.receipt } }
                      : {}),
                  },
                }
                : {}),
              ...(last
                ? {
                  lastWait: {
                    waitId: last.waitId,
                    settledAs: last.settledAs,
                    settledAt: last.settledAt,
                    ...(readable && last.receipt
                      ? { receipt: { ...last.receipt } }
                      : {}),
                  },
                }
                : {}),
            };
          }
        },
      },
    );
  } catch (error) {
    logger.warn("Signal for {address} failed: {error}", {
      address: named,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "failed", message: "Signal delivery failed" };
  }

  if (held !== undefined) {
    emitHeld(ctx, caller, request.requestId, held);
    if (receiptOnly) {
      return {
        status: "accepted",
        workflow: { id: held.workflowId, name: held.workflowName },
        data: acceptedData(held.signal, held.duplicate),
      };
    }
    return {
      status: "pending",
      workflow: { id: held.workflowId, name: held.workflowName },
      data: {
        signal: { ...held.signal },
        heldUntil: held.heldUntil,
        ...(held.duplicate ? { duplicate: true as const } : {}),
        ...(readable
          ? {
            key: held.key,
            workflowId: held.workflowId,
            workflowName: held.workflowName,
          }
          : {}),
        ...(held.lastWait
          ? {
            lastWait: {
              waitId: held.lastWait.waitId,
              settledAs: held.lastWait.settledAs,
              settledAt: held.lastWait.settledAt,
              ...(readable && held.lastWait.receipt
                ? { receipt: { ...held.lastWait.receipt } }
                : {}),
            },
          }
          : {}),
      },
    };
  }
  if (delivered === undefined) {
    return result ?? { status: "failed", message: "Signal delivery failed" };
  }

  emitDelivered(ctx, caller, request.requestId, delivered);
  if (receiptOnly) {
    return {
      status: "accepted",
      workflow: { id: delivered.workflowId, name: delivered.workflowName },
      run: {
        workflowId: delivered.workflowId,
        runId: delivered.runId,
        recordAvailable: delivered.runRecordAvailable,
      },
      data: acceptedData(delivered.signal, delivered.duplicate),
    };
  }
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
      ...(delivered.duplicate ? { duplicate: true as const } : {}),
      ...(readable
        ? {
          ...(delivered.key !== undefined ? { key: delivered.key } : {}),
          workflowId: delivered.workflowId,
          workflowName: delivered.workflowName,
          runId: delivered.runId,
          jobName: delivered.jobName,
          stepName: delivered.stepName,
          awaitingResume: delivered.awaitingResume,
          runRecordAvailable: delivered.runRecordAvailable,
          resumeCommand: delivered.resumeCommand,
          ...(delivered.taken ? { taken: true as const } : {}),
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
    client: caller.client,
    sourceIp: caller.sourceIp,
    requestId,
    // The key is the one the wait's registration holds, never request text.
    detail:
      `wait=${delivered.waitId} receipt=${delivered.signal.id} run=${delivered.runId}` +
      (delivered.key !== undefined ? ` key=${delivered.key}` : "") +
      (delivered.taken ? " taken=true" : "") +
      (delivered.duplicate ? " duplicate=true" : ""),
  }));
}

/**
 * the receipt and never the payload; the key is the one the workflow declares,
 * since the use case holds a signal only under a declared key
 */
function emitHeld(
  ctx: ConnectionContext,
  caller: AccessCaller,
  requestId: string,
  held: WorkflowSignalPendingData,
): void {
  if (!ctx.auditEmitter) return;
  const { principal } = caller;
  ctx.auditEmitter.emit(buildAuditEvent({
    instanceId: ctx.instanceId ?? "unknown",
    category: "execution",
    stage: "response",
    outcome: "success",
    action: "workflow.signal.pending",
    resourceKind: "workflow",
    resourceName: held.workflowName,
    principalKind: principal?.kind ?? "anonymous",
    principalId: principal?.id ?? "anonymous",
    initiatedBy: principal ? resolveDisplayPrincipal(principal, ctx) : "ghost",
    actor: resolveActorIdentity(
      principal,
      ctx.resolvedUserNames,
      caller.loginIdentity,
    ),
    client: caller.client,
    sourceIp: caller.sourceIp,
    requestId,
    detail:
      `receipt=${held.signal.id} key=${held.key} heldUntil=${held.heldUntil}` +
      (held.duplicate ? " duplicate=true" : ""),
  }));
}

/**
 * audits each pending signal a wait takes as workflow.signal.taken, never with
 * the payload, as a system event since no request made the take. Two instances
 * taking one signal both record it; same receipt ID
 */
export function auditTakenSignals(ctx: ConnectionContext): void {
  const waits = ctx.repoContext.signalWaits;
  if (!waits?.supported) return;
  waits.store.pendingTaken = (taken) =>
    emitSystemAuditEvent(
      ctx,
      "workflow.signal.taken",
      `receipt=${taken.receiptId} key=${taken.key} wait=${taken.waitId} run=${taken.runId} workflow=${taken.workflowId}`,
    );
}

/**
 * never throws: the signal is stored and the continuation sweep retries
 * whatever is not launched here. The HTTP route calls it before building its
 * reply and waits only for the launch.
 */
export async function continueAfterSignal(
  ctx: ConnectionContext,
  result: SignalDeliveryResult,
  subject: DecisionSubject,
): Promise<void> {
  // An `accepted` answer names a run only when a wait took the signal.
  const run = result.status === "delivered" || result.status === "accepted"
    ? result.run
    : undefined;
  if (run === undefined) return;
  try {
    if (!run.recordAvailable) await hydrateMissingRun(ctx, run);
    await continueSettledRun(ctx, run, {
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
        runId: run.runId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

/**
 * fetch only a missing record: a local one may hold an unpushed change a
 * download would overwrite. Taken under the sync gate and bounded so a stall
 * does not hold it; the sweep continues a run given up on
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
    await hydrate(runRepo.getPath(workflowId, runId), {
      signal: AbortSignal.timeout(RUN_RECORD_HYDRATE_TIMEOUT_MS),
    });
  });
}

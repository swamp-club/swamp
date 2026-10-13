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

/**
 * How a caller names the wait: by its ID, or by a workflow and a key one of
 * its `wait_for_signal` steps declares (swamp-club#3211).
 */
export type SignalDeliveryAddress =
  | { readonly waitId: string }
  | {
    /** The workflow's name or ID, as sent. */
    readonly workflow: string;
    readonly key: string;
  };

/** A signal as a caller sent it. The address and the payload are untrusted. */
export type SignalDeliveryRequest = SignalDeliveryAddress & {
  /** Identifies the request in audit events. */
  readonly requestId: string;
  readonly payload: unknown;
  /**
   * False for a caller that cannot read a `pending` answer: a signal by key
   * that finds no open wait is then refused `no_open_wait` and never held,
   * whatever the step declares (swamp-club#3212). Defaults to true.
   */
  readonly holdEarly?: boolean;
  /**
   * False for a caller that cannot read an `accepted` answer
   * (swamp-club#3213). Where that is the only answer the caller may be
   * given, the signal is then refused `upgrade_required` before any wait is
   * looked for. Defaults to true.
   */
  readonly acceptsReceipt?: boolean;
  /**
   * The sender's idempotency key, already in the form of one. A signal
   * whose key matches one already received is answered with that signal.
   */
  readonly idempotencyKey?: string;
};

/** What the transport that carries a signal is told along the way. */
export interface SignalDeliveryHooks {
  /**
   * Called with the canonical name of the workflow a key address names, as
   * soon as it resolves and whatever is then decided: the transport audits
   * the request under it, so the request's audit events and the denial's
   * name one resource when the workflow was named by its ID. It is never
   * sent to the caller.
   */
  readonly onWorkflowResolved?: (name: string) => void;
}

/** A refusal other than "not found" or a refused payload. */
export type SignalRefusalStatus =
  | "no_open_wait"
  | "expired"
  | "already_settled"
  | "already_pending"
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
  /**
   * By key: held as the key's pending signal (swamp-club#3212). No wait or
   * run took it, so no run is continued.
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
   * By key, for a caller who may not read the workflow, on a key whose step
   * sets `acceptEarly` (swamp-club#3213): the receipt alone, whether a wait
   * took the signal or it is held, so the answer does not say whether a run
   * is waiting.
   */
  | {
    readonly status: "accepted";
    readonly data: WorkflowSignalAcceptedResponseData;
    /** For the server's own use, as on a `pending` answer. */
    readonly workflow: { readonly id: string; readonly name: string };
    /**
     * The run of the wait that took the signal, when one did. For the
     * server's own use, as on a `delivered` answer.
     */
    readonly run?: {
      readonly workflowId: string;
      readonly runId: string;
      readonly recordAvailable: boolean;
    };
  }
  /**
   * The only answer the caller may be given is `accepted`, and their client
   * cannot read one. Nothing was delivered or stored.
   */
  | { readonly status: "upgrade_required"; readonly message: string }
  /**
   * An unknown wait ID, an unknown workflow, a key the workflow does not
   * declare, or a wait the caller may not signal.
   */
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
    /**
     * With `already_pending`: until when the earlier signal is held, and
     * what was recorded about it for a caller who may read the workflow.
     */
    readonly pending?: {
      readonly heldUntil: string;
      readonly receipt?: PendingSignalReceipt;
    };
    /**
     * With `no_open_wait`: the wait that last held the key and how it was
     * settled, so a sender who retries can tell a signal that landed from a
     * run that has not reached its wait. Its receipt is for a caller who may
     * read the workflow.
     */
    readonly lastWait?: SignalLastWait;
  }
  | { readonly status: "failed"; readonly message: string };

/** The one answer for a wait the caller cannot be told about. */
export const SIGNAL_WAIT_NOT_FOUND_MESSAGE = "Signal wait not found";

/** What a caller who may not read the workflow is told of each refusal. */
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
 * What a caller who may not read the workflow is told of the wait that last
 * held a key, after the fixed `no_open_wait` sentence. It says how the wait
 * was settled and when, which `lastWait` already tells them, and never by
 * which signal. A client that shows only the message, as the CLI does, can
 * then set the time against its own attempt: the same refusal reaches a
 * sender whose signal landed and one who is early for the next run.
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
 * The command a refusal suggests for listing the open waits. The server does
 * not know the address a client reached it by, so that is left to fill in.
 */
const SERVER_WAITS_COMMAND = "swamp workflow waits --server <server>";

/**
 * What a client that cannot read an `accepted` answer is told. The same
 * sentence whether or not a wait is open: it is decided before one is
 * looked for.
 */
export const SIGNAL_UPGRADE_REQUIRED_MESSAGE =
  "This server answers a signal for that key with a receipt this client cannot read, so the signal was not delivered and nothing was stored. Upgrade swamp here and send it again.";

/** The receipt as an `accepted` answer carries it: never the wait. */
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
 * The workflow a key address names, once the caller is known to be allowed
 * to signal it. The use case is handed exactly this workflow.
 */
interface AuthorizedKeyTarget {
  readonly id: string;
  readonly name: string;
  /** Whether the caller may also read the workflow. */
  readonly readable: boolean;
}

/**
 * Authorizes a signal addressed by key on the workflow the request names,
 * before any claim, registration or key declaration is read. The workflow
 * is resolved first, as every request that names a workflow is: selectors
 * match names and conditions read tags, so a deny by name must reach a
 * request by ID, and a rule on tags must see the tags. A string that
 * matches nothing is authorized as sent, so a refusal is audited with it.
 *
 * Key claims are kept per workflow ID, and IDs are not unique: a copied file
 * keeps its ID. So the caller needs `signal` on every workflow that shares
 * the named one's ID, not only on the one they named. Otherwise a caller
 * allowed on a copy would learn from `no_open_wait` against `not_found`
 * whether the original has an open wait under the key. The wait a key
 * resolves to is authorized again where it is placed, which also covers a
 * workflow renamed since the wait was opened.
 *
 * Returns the answer for a caller who goes no further: `not_found` for one
 * who may not signal the workflow and for a workflow that does not exist,
 * alike.
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
 * Delivers `request` for `caller`. The caller needs `signal` on every
 * workflow the wait belongs to; without it, or for a wait that does not
 * exist, the answer is `not_found` and nothing else. The workflow, run and
 * step, the run's state and an earlier signal's receipt are given only to a
 * caller who may also `read` those workflows.
 *
 * A signal addressed by workflow and key (swamp-club#3211) is authorized
 * twice. First on the workflow the request names and every workflow that
 * shares its ID, before anything about the key is read: a caller who may
 * not signal them, a workflow that does not exist and a key the workflow
 * does not declare are all `not_found`. Then,
 * as a signal by ID is, on every workflow the wait the key resolved to
 * belongs to: workflow IDs are not unique and key claims are kept per ID,
 * so a caller allowed on a copy must not reach the original's wait. A
 * declared key no open wait holds is `no_open_wait`, to a caller who may
 * signal the workflow.
 *
 * On a key whose step sets `acceptEarly`, a caller who may not read the
 * workflow they named is answered `accepted`, with the receipt alone
 * (swamp-club#3213). Whether that is so is decided once, from the authorized
 * workflow's definition and before any wait is looked for, and it holds for
 * every answer to the request: a signal a wait took and one that is held
 * read the same, a refusal names no time and no earlier wait, and the signal
 * is held whatever `holdEarly` says.
 *
 * Nothing is written but the wait's outcome record: no run is saved, no
 * claim or reservation is taken and nothing is pushed. Continuing the run
 * is the caller's next step (see {@link continueAfterSignal}).
 */
export async function deliverSignalForCaller(
  ctx: ConnectionContext,
  caller: AccessCaller,
  request: SignalDeliveryRequest,
  hooks: SignalDeliveryHooks = {},
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

  // What is logged of the address: the wait ID, or the workflow by key. The
  // key is logged only once it is known to be in the form of one.
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
                ? "Payload refused; nothing was stored:\n"
                : "Payload refused; the wait stays open:\n") +
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
 * Audits a signal held as a key's pending signal, with its receipt and
 * never its payload. The key is the one the workflow declares: the use case
 * holds a signal only under a declared key.
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
    sourceIp: caller.sourceIp,
    requestId,
    detail:
      `receipt=${held.signal.id} key=${held.key} heldUntil=${held.heldUntil}` +
      (held.duplicate ? " duplicate=true" : ""),
  }));
}

/**
 * Has every pending signal a wait takes through this server's wait store
 * audited as `workflow.signal.taken`, with the receipt ID, the key, the
 * wait and the run, and never the payload (swamp-club#3213). The step that
 * opens its wait, a signaller that finds the key claimed and the
 * continuation sweep all take through the one store, so each is recorded
 * whoever made it. No request made the take, so it is a system event. Two
 * instances that take one signal at the same moment both record it; the
 * receipt ID says they are one take.
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
 * Tries to continue the run a delivered signal belongs to, now that one
 * more of its waits is settled (swamp-club#3108). The WebSocket handler
 * calls it after sending its reply; the HTTP route before building its own,
 * which waits only for the launch, not for the run. Never throws: the
 * signal is stored, and the continuation sweep retries whatever is not
 * launched here.
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
 * Fetches the record of a run this instance does not have, from a datastore
 * whose run records are synced. Only a record that is missing is fetched:
 * one that is here may hold a change not pushed yet, which a download would
 * overwrite. Taken under the sync gate, so no handler's delete of the run
 * is between its removal and its push, and bounded, so a stalled download
 * does not hold the gate: the sweep continues a run this gives up on.
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

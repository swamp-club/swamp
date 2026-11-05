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

import type { Principal } from "../../domain/access/principal.ts";
import { MAX_RPC_FRAME_BYTES } from "../../domain/remote/rpc_channel.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { currentDiagnosticTally } from "../../domain/diagnostics/diagnostic_phase.ts";
import {
  createDataRepositoryAttributeReader,
  type ResourceAttributeReader,
  type ResourceReadPolicy,
} from "../../domain/workflows/step_output_resolver.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import {
  resolveCompletedRunOutputs,
  withRunStepOutputs,
} from "../../libswamp/workflows/run.ts";
import type { WorkflowRunView } from "../../libswamp/workflows/workflow_run_view.ts";
import type { SerializedEvent } from "../protocol.ts";
import { serializeEvent } from "../serializer.ts";
import { redactingFor } from "./nested_run_redaction.ts";
import { canonicalResources } from "./resource_resolution.ts";
import { type ConnectionContext, filterByResources } from "./shared.ts";

const logger = getSwampLogger(["serve", "run-data"]);

// room for the frame around the event: its type, request id and sequence number
const FRAME_ENVELOPE_BYTES = 64 * 1024;

/**
 * an event with attributes added must still fit one frame, or a run that
 * succeeded would reach its client as frame_too_large instead of name-only
 */
export const MAX_ATTRIBUTED_EVENT_BYTES = MAX_RPC_FRAME_BYTES -
  FRAME_ENVELOPE_BYTES;

function oversizeBytes(
  event: SerializedEvent,
  maxBytes: number,
): number | undefined {
  const json = JSON.stringify(event);
  // a UTF-16 code unit encodes to at most three UTF-8 bytes
  if (json.length * 3 <= maxBytes) return undefined;
  const bytes = new TextEncoder().encode(json).byteLength;
  return bytes > maxBytes ? bytes : undefined;
}

/**
 * the live completed run of one served run, kept beside its event stream and
 * never serialized: a run read back from its record masks none of its
 * sensitive values
 */
export interface CompletedRunSlot {
  run?: WorkflowRun;
  verbose?: boolean;
  reads?: SharedReads;
}

/**
 * one datastore read per record however many clients attach; each client
 * still gets its own read decision per resource
 */
interface SharedReads {
  cache: Map<string, Promise<Record<string, unknown> | undefined>>;
  bytes: number;
  // past the budget the event cannot carry them, so later clients read nothing
  overBudget: boolean;
}

function sharedReader(
  reads: SharedReads,
  read: ResourceAttributeReader,
  maxBytes: number,
): ResourceAttributeReader {
  return (ref) => {
    if (reads.overBudget) return Promise.resolve(undefined);
    const key = JSON.stringify([
      ref.modelType,
      ref.modelId,
      ref.name,
      ref.version,
    ]);
    const cached = reads.cache.get(key);
    if (cached) return cached;
    const pending = read(ref).then((attributes) => {
      if (attributes !== undefined && !reads.overBudget) {
        reads.bytes += JSON.stringify(attributes).length;
        if (reads.bytes > maxBytes) markOverBudget(reads);
      }
      return attributes;
    }, (error) => {
      // a failed read may be transient, so the next client tries again
      reads.cache.delete(key);
      throw error;
    });
    reads.cache.set(key, pending);
    return pending;
  };
}

// judged on everything read for the run, so a client with narrower rights whose
// share would have fit is also sent name-only
function markOverBudget(reads: SharedReads): void {
  reads.overBudget = true;
  reads.cache.clear();
}

/**
 * reading a run's data must not reveal what data.get would refuse, so each
 * resource goes through the same data read decision
 */
export function dataReadPolicy(
  socket: WebSocket,
  ctx: ConnectionContext,
  principal: Principal | null,
  signal?: AbortSignal,
): ResourceReadPolicy {
  const canonical = canonicalResources(ctx, signal);
  return async (ref) =>
    (await filterByResources(
      [ref],
      (item) =>
        currentDiagnosticTally().measure(
          "owner_lookup",
          () => canonical.dataOwners(item),
        ),
      socket,
      principal,
      "read",
      ctx,
    )).length === 1;
}

/**
 * adds to a completed event the attributes this subscriber may read; the
 * buffered event is shared by every attached client, so it never carries them
 */
export function dataAttributesFor(
  ctx: ConnectionContext,
  socket: WebSocket,
  principal: Principal | null,
  slot: CompletedRunSlot,
  signal?: AbortSignal,
  maxEventBytes: number = MAX_ATTRIBUTED_EVENT_BYTES,
): (event: SerializedEvent) => Promise<SerializedEvent> {
  return async (event) => {
    const run = slot.run;
    if (event.kind !== "completed" || run === undefined) return event;
    if (signal?.aborted) return event;
    slot.reads ??= { cache: new Map(), bytes: 0, overBudget: false };
    const reads = slot.reads;
    if (reads.overBudget) return event;
    const dataRepo = ctx.repoContext.unifiedDataRepo;
    const canRead = ctx.authConfig.mode === "none"
      ? undefined
      : dataReadPolicy(socket, ctx, principal, signal);
    const stepOutputs = await resolveCompletedRunOutputs(
      run,
      dataRepo,
      ctx.repoContext.workflowRunRepo,
      signal,
      canRead,
      sharedReader(
        reads,
        createDataRepositoryAttributeReader(dataRepo),
        maxEventBytes,
      ),
    );
    if (reads.overBudget) {
      logger.info(
        "Run {runId} completed event sent without data attributes: they pass {bytes} bytes, over the {limit} byte budget",
        { runId: run.id, bytes: reads.bytes, limit: maxEventBytes },
      );
      return event;
    }
    if (stepOutputs === undefined) return event;
    const attributed = serializeEvent({
      ...event,
      run: withRunStepOutputs(
        event.run as WorkflowRunView,
        run,
        stepOutputs,
        slot.verbose,
      ),
    });
    const bytes = oversizeBytes(attributed, maxEventBytes);
    if (bytes === undefined) return attributed;
    markOverBudget(reads);
    logger.info(
      "Run {runId} completed event sent without data attributes: with them it is {bytes} bytes, over the {limit} byte budget",
      { runId: run.id, bytes, limit: maxEventBytes },
    );
    return event;
  };
}

/**
 * what one client is sent of a run's events: its readable data attributes
 * added, then nested runs it may not read redacted
 */
export function runStreamFor(
  ctx: ConnectionContext,
  socket: WebSocket,
  principal: Principal | null,
  slot: CompletedRunSlot,
  signal?: AbortSignal,
): (event: SerializedEvent) => Promise<SerializedEvent> {
  const attributes = dataAttributesFor(ctx, socket, principal, slot, signal);
  const redact = redactingFor(ctx, socket, principal);
  return async (event) => {
    const withAttributes = await attributes(event);
    return redact ? await redact(withAttributes) : withAttributes;
  };
}

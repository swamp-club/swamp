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

import { withRunPhase } from "./run_progress.ts";

/** Versioned, transport-independent observations of remote execution. */
export const EXECUTION_TELEMETRY_VERSION = 1;

export interface TraceCarrier {
  traceparent: string;
  tracestate?: string;
}

function validTraceState(value: string): boolean {
  if (value.length > 512 || /[^\x20-\x7e]/.test(value)) return false;
  if (value === "") return true;
  const entries = value.split(",");
  if (entries.length > 32) return false;
  const keys = new Set<string>();
  for (const entry of entries) {
    const match =
      /^\s*((?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13}))=([\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e])\s*$/
        .exec(entry);
    if (!match || keys.has(match[1])) return false;
    keys.add(match[1]);
  }
  return true;
}

/** Invalid observational metadata is ignored, never an execution failure. */
export function traceCarrier(value: unknown): TraceCarrier | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { traceparent, tracestate } = value as Record<string, unknown>;
  if (
    typeof traceparent !== "string" ||
    !/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(traceparent) ||
    /^00-0{32}-/.test(traceparent) || /-0{16}-/.test(traceparent)
  ) return undefined;
  if (
    tracestate !== undefined && (typeof tracestate !== "string" ||
      !validTraceState(tracestate))
  ) return undefined;
  return {
    traceparent,
    ...(tracestate ? { tracestate: tracestate as string } : {}),
  };
}

/** Authenticated dispatch identity is authoritative, not a caller's headers. */
export function dispatchTraceCarrier(
  trusted: unknown,
  incoming: unknown,
): TraceCarrier | undefined {
  const owner = traceCarrier(trusted);
  const candidate = traceCarrier(incoming);
  return owner && candidate &&
      owner.traceparent.slice(3, 35) === candidate.traceparent.slice(3, 35) &&
      owner.traceparent.slice(53) === candidate.traceparent.slice(53)
    ? candidate
    : owner;
}

export function dispatchTraceCoverage(
  trusted: unknown,
  incoming: unknown,
): "nested" | "fallback" | "missing" {
  const owner = traceCarrier(trusted);
  if (!owner) return "missing";
  const candidate = traceCarrier(incoming);
  return candidate &&
      dispatchTraceCarrier(owner, candidate)?.traceparent ===
        candidate.traceparent
    ? "nested"
    : "fallback";
}

export type ExecutionOperation =
  | "step.dependency"
  | "step.scheduler"
  | "dispatch.logical"
  | "dispatch.lock_handoff"
  | "dispatch.lock_reclaim"
  | "dispatch.attempt"
  | "dispatch.queue"
  | "dispatch.affinity"
  | "dispatch.prepare"
  | "dispatch.send"
  | "dispatch.settle"
  | "worker.prepare"
  | "worker.dispatch"
  | "worker.execute"
  | "rpc.client"
  | "rpc.server"
  | "rpc.submit"
  | "rpc.late"
  | "query.execute"
  | "query.serialize"
  | "data.client"
  | "data.body"
  | "data.response"
  | "enrollment.connect"
  | "enrollment.request"
  | "enrollment.accepted"
  | "enrollment.retry"
  | "transition.wait"
  | "webhook.receipt"
  | "webhook.queue"
  | "webhook.run"
  // Phases of src/domain/diagnostics/diagnostic_phase.ts, which builds them
  // only from its closed DiagnosticPhase vocabulary. Typed as any suffix so
  // this module does not depend on diagnostics, which depends on it.
  | `diagnostic.${string}`;

export type ObservationAttributes = Readonly<
  Record<string, string | number | boolean>
>;
export type ObservationOutcome =
  | "ok"
  | "error"
  | "timeout"
  | "cancelled"
  | "closed";

export interface ExecutionObservation {
  readonly carrier: TraceCarrier | undefined;
  /** Whether this observation is exported (tracing on and sampled). */
  readonly recording?: boolean;
  run<T>(fn: () => T): T;
  attributes(values: ObservationAttributes): void;
  end(outcome: ObservationOutcome): void;
}

export interface ExecutionObserver {
  start(
    operation: ExecutionOperation,
    attributes: ObservationAttributes,
    parent?: TraceCarrier,
    links?: readonly TraceCarrier[],
  ): ExecutionObservation;
}

let observer: ExecutionObserver | undefined;
export function setExecutionObserver(
  value: ExecutionObserver | undefined,
): void {
  observer = value;
}

const silent: ExecutionObservation = {
  carrier: undefined,
  run: (fn) => fn(),
  attributes: () => {},
  end: () => {},
};

export function observeExecution(
  operation: ExecutionOperation,
  attributes: ObservationAttributes = {},
  parent?: TraceCarrier,
  links?: readonly TraceCarrier[],
): ExecutionObservation {
  return observer?.start(operation, attributes, parent, links) ?? silent;
}

export function observationOutcome(error: unknown): ObservationOutcome {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "timeout";
    if (error.name === "AbortError") return "cancelled";
    if (error.name === "ChannelClosedError") return "closed";
  }
  return "error";
}

export async function observeExecutionWork<T>(
  operation: ExecutionOperation,
  attributes: ObservationAttributes,
  fn: (observation: ExecutionObservation) => Promise<T>,
  parent?: TraceCarrier,
  links?: readonly TraceCarrier[],
): Promise<T> {
  const observation = observeExecution(operation, attributes, parent, links);
  try {
    const work = () => observation.run(() => fn(observation));
    const result =
      await (operation === "dispatch.queue" || operation === "dispatch.affinity"
        ? withRunPhase("waiting_for_worker", {}, work)
        : operation === "dispatch.send"
        ? withRunPhase("executing", {
          worker: typeof attributes["swamp.worker.id"] === "string"
            ? attributes["swamp.worker.id"]
            : undefined,
        }, work)
        : work());
    observation.end("ok");
    return result;
  } catch (error) {
    observation.end(observationOutcome(error));
    throw error;
  }
}

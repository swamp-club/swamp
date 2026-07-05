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
 * The domain-side port for dispatching a step to a remote worker.
 *
 * Workflow execution (domain layer) decides *that* a step is remote — a step
 * declaring `target`/`labels`/`platform` placement — and hands it to this
 * port. The orchestrator's DispatchService (serve layer) implements it and
 * registers itself here at startup; running a placed step outside a serving
 * orchestrator fails with a clear error instead of silently running locally.
 */

import type { UnifiedDataRepository } from "../data/repositories.ts";
import type { ModelDefinition } from "../models/model.ts";
import type { ModelType } from "../models/model_type.ts";
import type { StepPlacement } from "./scheduler.ts";
import type { DispatchOutput, RpcStreamEvent } from "./protocol.ts";

export interface RemoteStepRequest {
  placement: StepPlacement;
  modelDef: ModelDefinition;
  modelType: ModelType;
  modelId: string;
  methodName: string;
  definitionName: string;
  definitionTags: Record<string, string>;
  definitionMeta: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
  };
  globalArgs: Record<string, unknown>;
  methodArgs: Record<string, unknown>;
  resourceSpecs?: Record<string, unknown>;
  fileSpecs?: Record<string, unknown>;
  /** W3C trace context propagated into the worker's execution. */
  traceHeaders?: Record<string, string>;
  runtimeTags?: Record<string, string>;
  workflowName?: string;
  jobName?: string;
  stepName?: string;
  signal?: AbortSignal;
  onEvent?: (event: RpcStreamEvent) => void;
  dataRepo?: UnifiedDataRepository;
  /** Dispatch-level probe marker for fleet verification. */
  probeMarker?: string;
  /**
   * Bypass the scheduler and dispatch directly to the targeted worker.
   * Only used by the fleet verification probe, which must reach workers
   * in "unverified" status that the scheduler would otherwise exclude.
   * Requires `placement.target` to be set.
   */
  skipScheduler?: boolean;
}

export interface RemoteStepResult {
  outputs: DispatchOutput[];
  logs: string[];
  durationMs: number;
  followUpActions?: unknown[];
  /** The worker that executed the step (telemetry attribution). */
  workerName?: string;
}

export interface RemoteStepDispatcher {
  executeRemote(request: RemoteStepRequest): Promise<RemoteStepResult>;
}

let activeDispatcher: RemoteStepDispatcher | null = null;

/** Called by the orchestrator at startup (and cleared on shutdown). */
export function setRemoteStepDispatcher(
  dispatcher: RemoteStepDispatcher | null,
): void {
  activeDispatcher = dispatcher;
}

export function getRemoteStepDispatcher(): RemoteStepDispatcher | null {
  return activeDispatcher;
}

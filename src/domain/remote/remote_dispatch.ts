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
import type {
  LockHandOff,
  RemoteLockHolder,
} from "../datastore/lock_holder_marker.ts";
import type { DataOutputOverride } from "../models/data_output_override.ts";
import type { ModelDefinition } from "../models/model.ts";
import type { ModelType } from "../models/model_type.ts";
import type { StepPlacement } from "./scheduler.ts";
import type { DispatchOutput, RpcStreamEvent } from "./protocol.ts";
import type {
  SecretBagEntry,
  SecretReference,
  ShippedReferenceEntry,
} from "../vaults/secret_bag_registry.ts";

/**
 * The plaintext frame a protocol version 5 worker receives, for the
 * deprecation window typed-secrets 5.3 ends (design/enablers/typed-secrets.md
 * Section 9): the arguments with their secrets resolved, the step's bag
 * entries with their values, and the values the worker's redactor masks.
 */
export interface LegacyStepDelivery {
  globalArgs: Record<string, unknown>;
  methodArgs: Record<string, unknown>;
  /**
   * Resolved vault secret values for the worker's SecretRedactor, and the
   * sensitive argument values a local run would register.
   */
  secretValues?: string[];
  /**
   * Method args with vault sentinels intact, shipped with {@link secretBag}
   * so the worker resolves them itself (see DispatchParams).
   */
  unresolvedMethodArgs?: Record<string, unknown>;
  /** The step's vault secret bag entries, with their values. */
  secretBag?: SecretBagEntry[];
}

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
  /**
   * The step's global and method arguments as the definition holds them:
   * sentinels in place of secrets, and the global arguments not yet
   * validated. A version 6 worker loads, resolves and validates them
   * itself; a version 5 worker gets {@link legacyDelivery}'s instead.
   */
  globalArgs: Record<string, unknown>;
  methodArgs: Record<string, unknown>;
  resourceSpecs?: Record<string, unknown>;
  fileSpecs?: Record<string, unknown>;
  /** W3C trace context propagated into the worker's execution. */
  traceHeaders?: Record<string, string>;
  runtimeTags?: Record<string, string>;
  tagOverrides?: Record<string, string>;
  dataOutputOverrides?: DataOutputOverride[];
  workflowName?: string;
  /** The workflow run this step belongs to, recorded on its step lease. */
  workflowRunId?: string;
  jobName?: string;
  stepName?: string;
  signal?: AbortSignal;
  onEvent?: (event: RpcStreamEvent) => void;
  dataRepo?: UnifiedDataRepository;
  /** Dispatch-level probe marker for fleet verification. */
  probeMarker?: string;
  /**
   * One reference-only entry per sentinel the arguments carry, which a
   * version 6 dispatch ships as its bag. Absent when the step holds no
   * secret.
   */
  referenceBag?: ShippedReferenceEntry[];
  /**
   * The references behind {@link referenceBag}, which serve admits to the
   * dispatch's own secret reads and loads (swamp-club#3529).
   */
  secretReferences?: readonly SecretReference[];
  /**
   * Sensitive literal values the arguments hold as authored, for serve's
   * dispatch redactor. They are not secrets the typed-secrets contract
   * covers (design/enablers/typed-secrets.md Section 1.3).
   */
  redactorSeeds?: string[];
  /**
   * Builds the frame a version 5 worker receives: it loads the step's
   * references and validates its arguments, so it is called only once the
   * dispatcher has chosen a version 5 worker, and at most once per attempt
   * however many such workers the attempt is dispatched to. Absent when the
   * arguments hold no secret and need no validation on serve, as for a
   * fleet probe: the arguments above are then the frame's.
   */
  legacyDelivery?: () => Promise<LegacyStepDelivery>;
  /**
   * Places data text in a frame's global and method arguments for the
   * shell of the chosen worker, by the platform it enrolled with
   * (swamp-club#3868). Called for every dispatch attempt, since a
   * re-dispatch can choose a worker of another platform; it throws to
   * refuse. Required: a dispatcher that skipped it would run data as
   * authored text. A step whose arguments hold no data passes the identity.
   */
  placeArguments: (
    args: {
      globalArgs: Record<string, unknown>;
      methodArgs: Record<string, unknown>;
    },
    platform: string,
  ) => {
    globalArgs: Record<string, unknown>;
    methodArgs: Record<string, unknown>;
  };
  /**
   * Called when a version 6 worker reports that the step's arguments
   * passed their schema, at most once however many workers report it
   * (swamp-club#3681).
   */
  onArgumentsValidated?: () => Promise<void>;
  /**
   * Begins the hand-off of the per-model locks held for the step to one
   * dispatch attempt, so a swamp the step starts on the worker skips them.
   * Call it once per attempt, send what it lends, and await its end when
   * the attempt returns, is cancelled or loses its worker: the locks are
   * then re-keyed, so a retry carries new nonces and whatever the attempt
   * left running stops skipping them.
   */
  beginLockHandOff?: () => Promise<LockHandOff<RemoteLockHolder | undefined>>;
  /**
   * Bypass the scheduler and dispatch directly to the targeted worker.
   * Only used by the fleet verification probe, which must reach workers
   * in "unverified" status that the scheduler would otherwise exclude.
   * Requires `placement.target` to be set.
   */
  skipScheduler?: boolean;
  /**
   * When true, the dispatch is pre-marked as write-bearing before the
   * method body runs. A worker disconnect fails the run immediately
   * instead of re-dispatching — even if no data-plane write has occurred.
   */
  declaredWrites?: boolean;
}

export interface RemoteStepResult {
  outputs: DispatchOutput[];
  logs: string[];
  durationMs: number;
  /** The worker that executed the step (telemetry attribution). */
  workerName?: string;
}

export interface RemoteStepDispatcher {
  executeRemote(request: RemoteStepRequest): Promise<RemoteStepResult>;
  releaseAffinity(key: string): void;
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

let remoteOnlyMode = false;

/** Called by the orchestrator at startup when --remote-only is set. */
export function setRemoteOnlyMode(enabled: boolean): void {
  remoteOnlyMode = enabled;
}

export function isRemoteOnlyMode(): boolean {
  return remoteOnlyMode;
}

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
 * workflow execution hands placed steps to this port; serve's DispatchService
 * registers itself at startup; outside a serving orchestrator a placed step
 * fails with a clear error instead of running locally
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
 * the plaintext frame a version 5 worker receives, for the deprecation window:
 * resolved arguments, bag entries with values, and the values the worker's
 * redactor masks
 */
export interface LegacyStepDelivery {
  globalArgs: Record<string, unknown>;
  methodArgs: Record<string, unknown>;
  secretValues?: string[];
  unresolvedMethodArgs?: Record<string, unknown>;
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
   * arguments as the definition holds them: sentinels for secrets, global args
   * not yet validated; a version 6 worker resolves and validates them itself, a
   * version 5 worker gets legacyDelivery's
   */
  globalArgs: Record<string, unknown>;
  methodArgs: Record<string, unknown>;
  resourceSpecs?: Record<string, unknown>;
  fileSpecs?: Record<string, unknown>;
  traceHeaders?: Record<string, string>;
  runtimeTags?: Record<string, string>;
  tagOverrides?: Record<string, string>;
  dataOutputOverrides?: DataOutputOverride[];
  workflowName?: string;
  workflowRunId?: string;
  jobName?: string;
  stepName?: string;
  signal?: AbortSignal;
  onEvent?: (event: RpcStreamEvent) => void;
  dataRepo?: UnifiedDataRepository;
  probeMarker?: string;
  referenceBag?: ShippedReferenceEntry[];
  /**
   * the references behind referenceBag, which serve admits to the dispatch's
   * own secret reads and loads
   */
  secretReferences?: readonly SecretReference[];
  /**
   * sensitive literal values the arguments hold as authored, for serve's
   * dispatch redactor; not secrets the typed-secrets contract covers
   */
  redactorSeeds?: string[];
  /**
   * builds the version 5 frame; called only once a version 5 worker is chosen,
   * at most once per attempt; absent when the arguments hold no secret and need
   * no validation on serve
   */
  legacyDelivery?: () => Promise<LegacyStepDelivery>;
  /**
   * places data text in arguments for the chosen worker's shell by platform;
   * called per attempt since a re-dispatch may pick another platform; throws to
   * refuse; required so data never runs as authored text
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
   * called when a version 6 worker reports the arguments passed their schema,
   * at most once however many workers report it
   */
  onArgumentsValidated?: () => Promise<void>;
  /**
   * call once per attempt and await its end when the attempt returns, is
   * cancelled or loses its worker: the locks are re-keyed, so a retry carries
   * new nonces and leftovers stop skipping them
   */
  beginLockHandOff?: () => Promise<LockHandOff<RemoteLockHolder | undefined>>;
  /**
   * bypasses the scheduler; only for the fleet probe, which must reach
   * unverified workers the scheduler excludes; requires placement.target
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
  workerName?: string;
}

/**
 * carries the outputs a failed dispatch wrote, so the step records them as it
 * does a local failure's; an error that cannot take the property is returned
 * unchanged
 */
export function withRemoteOutputs(
  error: unknown,
  outputs: readonly DispatchOutput[],
): unknown {
  if (outputs.length === 0) return error;
  if (typeof error !== "object" || error === null) return error;
  try {
    Object.defineProperty(error, "remoteOutputs", {
      value: [...outputs],
      configurable: true,
      writable: true,
    });
  } catch {
    // A frozen error keeps what it has.
  }
  return error;
}

export function remoteOutputsOf(error: unknown): DispatchOutput[] {
  if (typeof error !== "object" || error === null) return [];
  const outputs = (error as { remoteOutputs?: unknown }).remoteOutputs;
  if (!Array.isArray(outputs)) return [];
  return outputs.filter((o): o is DispatchOutput =>
    typeof o === "object" && o !== null &&
    typeof o.dataId === "string" && typeof o.name === "string" &&
    typeof o.specName === "string" && typeof o.version === "number" &&
    (o.type === "resource" || o.type === "file")
  );
}

export interface RemoteStepDispatcher {
  executeRemote(request: RemoteStepRequest): Promise<RemoteStepResult>;
  releaseAffinity(key: string): void;
}

let activeDispatcher: RemoteStepDispatcher | null = null;

export function setRemoteStepDispatcher(
  dispatcher: RemoteStepDispatcher | null,
): void {
  activeDispatcher = dispatcher;
}

export function getRemoteStepDispatcher(): RemoteStepDispatcher | null {
  return activeDispatcher;
}

let remoteOnlyMode = false;

export function setRemoteOnlyMode(enabled: boolean): void {
  remoteOnlyMode = enabled;
}

export function isRemoteOnlyMode(): boolean {
  return remoteOnlyMode;
}

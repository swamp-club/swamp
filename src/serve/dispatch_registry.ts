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
 * Registry of in-flight dispatches, keyed by (worker name, dispatch id).
 * A worker may have up to its capacity in concurrent active dispatches.
 * The data plane and capability service consult this to authorize and
 * scope a worker's operations to the correct dispatch.
 */

import type { UnifiedDataRepository } from "../domain/data/repositories.ts";
import type { DataOutputOverride } from "../domain/models/data_output_override.ts";
import type { ModelDefinition } from "../domain/models/model.ts";
import type { ModelType } from "../domain/models/model_type.ts";
import type {
  VaultExtractionResult,
} from "../domain/expressions/vault_reference_extractor.ts";
import type { SecretRedactor } from "../domain/secrets/secret_redactor.ts";
import type { RunVaultAccess } from "../domain/vaults/run_vault_access.ts";
import type { SecretReference } from "../domain/vaults/secret_bag_registry.ts";
import type { RunProgress } from "../domain/remote/run_progress.ts";

export interface ActiveDispatch {
  /** Captured by serve; never supplied by the worker. */
  progress?: RunProgress;
  workerName: string;
  dispatchId: string;
  leaseId: string;
  /** The real model definition — carries the spec schemas writers enforce. */
  modelDef: ModelDefinition;
  modelType: ModelType;
  modelId: string;
  methodName: string;
  definitionName: string;
  definitionTags: Record<string, string>;
  runtimeTags?: Record<string, string>;
  tagOverrides?: Record<string, string>;
  dataOutputOverrides?: DataOutputOverride[];
  dataRepo?: UnifiedDataRepository;
  allowedSecrets?: VaultExtractionResult;
  /**
   * The references behind the sentinels of the step's arguments, as
   * {@link bagReferenceId}s: the dispatch's own bag, which the protected
   * load route admits and nothing else (design/enablers/typed-secrets.md
   * Section 9). Unlike {@link allowedSecrets}, no dynamic reference widens
   * it, and an absent set admits nothing.
   */
  bagReferences?: ReadonlySet<string>;
  /**
   * Per-dispatch redactor. Seeded with the secret values the step was
   * dispatched with (none for a version 6 dispatch, beyond the sensitive
   * literals its arguments hold), and grown with every value
   * `resolveSecret` or the protected load route delivers to the dispatch
   * afterwards (swamp-club#3527). The data plane scrubs the
   * dispatch's resource writes with it.
   */
  redactor?: SecretRedactor;
  /**
   * The protocol version of the frame this work was dispatched with. A
   * version 6 dispatch carries references only, so `resolveSecret` reads no
   * value for it: its runner loads through the protected route.
   */
  protocolVersion?: number;
  /**
   * W3C trace headers of the span that dispatched this work. The data plane
   * runs the dispatch's requests in this trace. Recorded by serve, so a
   * worker's request can never choose the trace its work joins.
   */
  traceHeaders?: Readonly<Record<string, string>>;
  /**
   * The vault access of the run that dispatched this work, captured at
   * dispatch (swamp-club#2676). The capability service and data plane hold
   * the worker's vault operations for this dispatch to it.
   */
  vaultAccess?: RunVaultAccess;
}

/** The identity of a vault reference in {@link ActiveDispatch.bagReferences}. */
export function bagReferenceId(vaultName: string, key: string): string {
  return `${vaultName}\u0000${key}`;
}

/** The {@link ActiveDispatch.bagReferences} of `references`. */
export function bagReferenceSet(
  references: readonly SecretReference[] | undefined,
): ReadonlySet<string> {
  return new Set(
    (references ?? []).map((ref) => bagReferenceId(ref.vaultName, ref.key)),
  );
}

export class DispatchRegistry {
  readonly #byWorker = new Map<string, Map<string, ActiveDispatch>>();

  register(dispatch: ActiveDispatch): void {
    let dispatches = this.#byWorker.get(dispatch.workerName);
    if (!dispatches) {
      dispatches = new Map();
      this.#byWorker.set(dispatch.workerName, dispatches);
    }
    dispatches.set(dispatch.dispatchId, dispatch);
  }

  unregister(workerName: string, dispatchId: string): void {
    const dispatches = this.#byWorker.get(workerName);
    if (dispatches) {
      dispatches.delete(dispatchId);
      if (dispatches.size === 0) {
        this.#byWorker.delete(workerName);
      }
    }
  }

  forDispatch(workerName: string, dispatchId: string): ActiveDispatch | null {
    return this.#byWorker.get(workerName)?.get(dispatchId) ?? null;
  }

  forWorker(workerName: string): ActiveDispatch[] {
    const dispatches = this.#byWorker.get(workerName);
    return dispatches ? [...dispatches.values()] : [];
  }

  activeCount(workerName: string): number {
    return this.#byWorker.get(workerName)?.size ?? 0;
  }
}

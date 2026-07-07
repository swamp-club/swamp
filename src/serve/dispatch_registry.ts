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
import type { ModelDefinition } from "../domain/models/model.ts";
import type { ModelType } from "../domain/models/model_type.ts";
import type {
  VaultExtractionResult,
} from "../domain/expressions/vault_reference_extractor.ts";

export interface ActiveDispatch {
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
  dataRepo?: UnifiedDataRepository;
  allowedSecrets?: VaultExtractionResult;
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

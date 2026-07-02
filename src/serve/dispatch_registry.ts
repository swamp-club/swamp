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
 * Registry of in-flight dispatches, keyed by worker name. The dispatcher
 * registers a dispatch before sending it and unregisters it when the result
 * (or failure) lands; the data plane consults it to authorize and shape a
 * worker's writes — a worker may only write through the declared output
 * specs of the model method it is currently leased to run (see
 * design/remote-execution.md, "Authenticating the data plane").
 */

import type { UnifiedDataRepository } from "../domain/data/repositories.ts";
import type { ModelDefinition } from "../domain/models/model.ts";
import type { ModelType } from "../domain/models/model_type.ts";

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
}

export class DispatchRegistry {
  readonly #byWorker = new Map<string, ActiveDispatch>();

  register(dispatch: ActiveDispatch): void {
    if (this.#byWorker.has(dispatch.workerName)) {
      throw new Error(
        `Worker '${dispatch.workerName}' already has an active dispatch`,
      );
    }
    this.#byWorker.set(dispatch.workerName, dispatch);
  }

  unregister(workerName: string, dispatchId: string): void {
    const active = this.#byWorker.get(workerName);
    if (active && active.dispatchId === dispatchId) {
      this.#byWorker.delete(workerName);
    }
  }

  forWorker(workerName: string): ActiveDispatch | null {
    return this.#byWorker.get(workerName) ?? null;
  }
}

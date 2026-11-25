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

import {
  createResourceReader,
  createResourceWriter,
} from "../domain/models/data_writer.ts";
import {
  nextWorkerState,
  type ReassertDecision,
  reassertDecision,
  type SetStatusArgs,
  statusWriteBase,
  WORKER_MODEL_TYPE,
  WORKER_STATE_DATA_NAME,
  workerDefinitionName,
  type WorkerEnrollment,
  workerModel,
  WorkerStateSchema,
} from "../domain/models/worker/worker_model.ts";
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { withSpan } from "../infrastructure/tracing/mod.ts";
import type { ModelMethodRunner } from "./worker_gateway.ts";

export interface WorkerStatusStore {
  /** `live` is the enrollment of the connection this serve holds, when it holds one */
  recordStatus(
    workerName: string,
    args: SetStatusArgs,
    live?: WorkerEnrollment,
  ): Promise<void>;
  reassert?(
    workerName: string,
    args: SetStatusArgs,
    live: WorkerEnrollment,
  ): Promise<ReassertDecision>;
}

export function methodRunnerWorkerStatusStore(
  runModelMethod: ModelMethodRunner,
): WorkerStatusStore {
  return {
    recordStatus: (workerName, args) =>
      runModelMethod({
        typeArg: WORKER_MODEL_TYPE.normalized,
        definitionName: workerDefinitionName(workerName),
        methodName: "set_status",
        inputs: { ...args },
      }),
  };
}

// bypasses the method run so a status change records no output, run log or evaluated definition
export class WorkerStatusLedger implements WorkerStatusStore {
  readonly #repoContext: Pick<
    RepositoryContext,
    "definitionRepo" | "unifiedDataRepo" | "markDirty" | "commitLog"
  >;
  readonly #fallback: WorkerStatusStore;
  readonly #ensureDefinition?: (workerName: string) => Promise<void>;

  constructor(
    repoContext: Pick<
      RepositoryContext,
      "definitionRepo" | "unifiedDataRepo" | "markDirty" | "commitLog"
    >,
    fallback: WorkerStatusStore,
    ensureDefinition?: (workerName: string) => Promise<void>,
  ) {
    this.#repoContext = repoContext;
    this.#fallback = fallback;
    this.#ensureDefinition = ensureDefinition;
  }

  // read-then-write with no compare-and-swap: the gateway orders a worker's changes
  recordStatus(
    workerName: string,
    args: SetStatusArgs,
    live?: WorkerEnrollment,
  ): Promise<void> {
    return withSpan(
      "swamp.serve.worker_status.write",
      { "swamp.worker.status": args.status },
      async () => {
        await this.#write(workerName, args, live, () => true);
      },
    );
  }

  /** rewrites a connected worker's record only when it says the worker is gone */
  reassert(
    workerName: string,
    args: SetStatusArgs,
    live: WorkerEnrollment,
  ): Promise<ReassertDecision> {
    return withSpan(
      "swamp.serve.worker_status.reassert",
      { "swamp.worker.status": args.status },
      async () => {
        let decision: ReassertDecision = "keep";
        await this.#write(workerName, args, live, (stored) => {
          decision = reassertDecision(
            stored === null ? null : WorkerStateSchema.parse(stored),
            live,
          );
          return decision === "rewrite";
        });
        return decision;
      },
    );
  }

  async #write(
    workerName: string,
    args: SetStatusArgs,
    live: WorkerEnrollment | undefined,
    shouldWrite: (stored: Record<string, unknown> | null) => boolean,
  ): Promise<void> {
    const definitionName = workerDefinitionName(workerName);
    let definition = await this.#repoContext.definitionRepo.findByName(
      WORKER_MODEL_TYPE,
      definitionName,
    );
    if (definition === null && live !== undefined) {
      // nothing to mark departing; a live worker's record is recreated
      if (args.status === "disconnected" || args.status === "draining") {
        return;
      }
      if (!shouldWrite(null)) return;
      if (this.#ensureDefinition !== undefined) {
        await this.#ensureDefinition(workerName);
        definition = await this.#repoContext.definitionRepo.findByName(
          WORKER_MODEL_TYPE,
          definitionName,
        );
      }
    }
    // the method run resolves a definition that does not exist yet
    if (definition === null) {
      await this.#fallback.recordStatus(workerName, args, live);
      return;
    }
    const found = definition;
    const repo = this.#repoContext.unifiedDataRepo;
    const resources = workerModel.resources!;
    // no push of its own, matching the method run's unit: a dispatching
    // run's root carries the write, and outside one it goes to the hook
    await runInRootUnitOfWork(
      this.#repoContext,
      { flush: undefined },
      async () => {
        const read = createResourceReader(
          repo,
          WORKER_MODEL_TYPE,
          found.id,
          undefined,
          undefined,
          resources,
        );
        const stored = await read(WORKER_STATE_DATA_NAME);
        if (!shouldWrite(stored)) return;
        const base = statusWriteBase(
          definitionName,
          stored,
          args,
          live,
          new Date(),
        );
        if (base.kind === "skip") return;
        const { writeResource } = createResourceWriter(
          repo,
          WORKER_MODEL_TYPE,
          found.id,
          resources,
          undefined,
          undefined,
          found.tags,
          undefined,
          found.name,
        );
        await writeResource(
          "state",
          WORKER_STATE_DATA_NAME,
          nextWorkerState(base.base, args, new Date()),
        );
      },
    );
  }
}
